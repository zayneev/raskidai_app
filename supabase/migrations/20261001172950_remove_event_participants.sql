-- Retain membership rows for financial history, but revoke access on removal.
alter table public.event_participants add column removed_at timestamptz;

create or replace function public.app_member(p_actor uuid, p_event uuid) returns boolean
language sql stable set search_path = public as $$
  select exists(select 1 from event_participants where event_id=p_event and user_id=p_actor and removed_at is null);
$$;

create or replace function public.app_snapshot(p_actor uuid) returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',e.id,'name',e.name,'cover',e.cover,'archived',e.archived,'ownerId',e.owner_id,
    'members',(select coalesce(jsonb_agg(jsonb_build_object('id',u.id,'firstName',u.first_name,'lastName',u.last_name,'username',u.username,'removed',p.removed_at is not null) order by p.joined_at), '[]'::jsonb)
      from event_participants p join app_users u on u.id=p.user_id where p.event_id=e.id),
    'expenses',(select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'title',x.title,'amount',x.amount_cents,'payer',x.payer_id,'author',x.author_id,'category',x.category,'date',x.spent_on,'mode',x.split_mode,'version',x.version,
      'splits',(select coalesce(jsonb_object_agg(s.user_id,s.amount_cents),'{}'::jsonb) from expense_shares s where s.expense_id=x.id),
      'history',(select coalesce(jsonb_agg(h.action || ' пользователем: ' || u.first_name || ' ' || u.last_name order by h.happened_at),'[]'::jsonb) from change_history h join app_users u on u.id=h.actor_id where h.entity='expense' and h.entity_id=x.id)
    ) order by x.created_at desc),'[]'::jsonb) from expenses x where x.event_id=e.id and x.deleted_at is null),
    'settlements',(select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'from',t.sender_id,'to',t.recipient_id,'amount',t.amount_cents,'date',t.transfer_on,'status',t.status,'confirmedBy',case when t.status='confirmed' then t.recipient_id else null end) order by t.created_at desc),'[]'::jsonb) from transfers t where t.event_id=e.id)
  ) order by e.created_at desc),'[]'::jsonb)
  from events e where app_member(p_actor,e.id);
$$;

create function public.app_remove_participant(p_actor uuid, p_event uuid, p_member uuid) returns boolean
language plpgsql set search_path = public as $$
declare v_removed timestamptz;
begin
  -- All expense and transfer mutations acquire the same event lock first.
  perform 1 from events where id=p_event and owner_id=p_actor and not archived for update;
  if not found or not app_member(p_actor,p_event) then raise exception 'Forbidden'; end if;
  if p_member=p_actor then raise exception 'Создателя мероприятия нельзя удалить'; end if;
  select removed_at into v_removed from event_participants where event_id=p_event and user_id=p_member for update;
  if not found then raise exception 'Участник не найден в мероприятии'; end if;
  if v_removed is not null then return true; end if;
  if exists(select 1 from transfers where event_id=p_event and status='pending' and (sender_id=p_member or recipient_id=p_member)) then
    raise exception 'Сначала подтвердите все переводы участника';
  end if;
  if app_balance(p_event,p_member)<>0 then raise exception 'Сначала завершите расчёты с участником'; end if;
  update event_participants set removed_at=clock_timestamp() where event_id=p_event and user_id=p_member;
  insert into change_history(event_id,actor_id,entity,entity_id,action,after_data)
    values(p_event,p_actor,'participant',p_member,'Участник удалён',jsonb_build_object('userId',p_member));
  return true;
end $$;

create or replace function public.app_create_invite(p_actor uuid, p_event uuid, p_hash text) returns uuid
language plpgsql set search_path = public as $$
declare v_id uuid;
begin
  perform 1 from events where id=p_event and owner_id=p_actor and not archived for update;
  if not found or not app_member(p_actor,p_event) then raise exception 'Forbidden'; end if;
  insert into event_invitations(event_id,token_hash,created_by,expires_at,created_at)
    values(p_event,p_hash,p_actor,now()+interval '7 days',clock_timestamp()) returning id into v_id;
  return v_id;
end $$;

create or replace function public.app_join_event(p_actor uuid, p_hash text) returns uuid
language plpgsql set search_path = public as $$
declare v_event uuid; v_invited_at timestamptz; v_removed_at timestamptz;
begin
  select event_id into v_event from event_invitations where token_hash=p_hash;
  if v_event is null then raise exception 'Invitation expired or invalid'; end if;
  perform 1 from events where id=v_event and not archived for update;
  if not found then raise exception 'Invitation expired or invalid'; end if;
  select created_at into v_invited_at from event_invitations
    where token_hash=p_hash and revoked_at is null and expires_at>now();
  if not found then raise exception 'Invitation expired or invalid'; end if;
  select removed_at into v_removed_at from event_participants where event_id=v_event and user_id=p_actor;
  if v_removed_at is not null and v_invited_at<=v_removed_at then
    raise exception 'Ссылка создана до удаления. Попросите создателя прислать новое приглашение';
  end if;
  insert into event_participants(event_id,user_id,joined_at) values(v_event,p_actor,clock_timestamp())
    on conflict (event_id,user_id) do update set removed_at=null
    where event_participants.removed_at is not null;
  return v_event;
end $$;

revoke all on function public.app_remove_participant(uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function public.app_remove_participant(uuid,uuid,uuid) to service_role;

-- Preserve settled history involving former participants.
create or replace function public.app_save_expense(p_actor uuid, p_event uuid, p_data jsonb, p_request uuid, p_expected_version integer default null)
returns jsonb language plpgsql set search_path = public as $$
declare v_id uuid; v_existing expenses%rowtype; v_fingerprint text := md5(p_event::text || p_data::text || coalesce(p_expected_version::text,''));
        v_request app_requests%rowtype; v_share record; v_total bigint := 0; v_count integer := 0; v_result jsonb;
begin
  perform 1 from events where id=p_event and not archived for update;
  if not found or not app_member(p_actor,p_event) then raise exception 'Forbidden'; end if;
  select * into v_request from app_requests where actor_id=p_actor and request_id=p_request;
  if found then
    if v_request.fingerprint<>v_fingerprint then raise exception 'Idempotency key reused'; end if;
    return v_request.result;
  end if;
  v_id := (p_data->>'id')::uuid;
  select * into v_existing from expenses where id=v_id for update;
  if found then
    if v_existing.event_id<>p_event or v_existing.deleted_at is not null or
       (v_existing.author_id<>p_actor and not exists(select 1 from events where id=p_event and owner_id=p_actor)) then raise exception 'Forbidden'; end if;
    if not app_member(v_existing.payer_id,p_event) or exists(
      select 1 from expense_shares s where s.expense_id=v_id and not app_member(s.user_id,p_event)
    ) then raise exception 'Расход связан с удалённым участником. Сначала пригласите его снова'; end if;
    if p_expected_version is null or p_expected_version<>v_existing.version then raise exception 'Version conflict'; end if;
    update expenses set title=trim(p_data->>'title'), amount_cents=(p_data->>'amount')::bigint,
      category=p_data->>'category', spent_on=(p_data->>'date')::date, split_mode=p_data->>'mode',
      version=version+1, updated_at=now() where id=v_id;
    delete from expense_shares where expense_id=v_id;
  else
    if p_expected_version is not null then raise exception 'Version conflict'; end if;
    insert into expenses(id,event_id,author_id,payer_id,title,amount_cents,category,spent_on,split_mode)
    values(v_id,p_event,p_actor,p_actor,trim(p_data->>'title'),(p_data->>'amount')::bigint,
      p_data->>'category',(p_data->>'date')::date,p_data->>'mode');
  end if;
  for v_share in select key,value from jsonb_each_text(p_data->'splits') loop
    if not app_member(v_share.key::uuid,p_event) then raise exception 'Share belongs to outsider'; end if;
    if v_share.value::bigint<0 then raise exception 'Negative share'; end if;
    insert into expense_shares(expense_id,user_id,amount_cents) values(v_id,v_share.key::uuid,v_share.value::bigint);
    v_total:=v_total+v_share.value::bigint; v_count:=v_count+1;
  end loop;
  if v_count=0 or v_total<>(p_data->>'amount')::bigint then raise exception 'Shares do not add up'; end if;
  insert into change_history(event_id,actor_id,entity,entity_id,action,before_data,after_data)
    values(p_event,p_actor,'expense',v_id,case when v_existing.id is null then 'Расход добавлен' else 'Расход изменён' end,
      case when v_existing.id is null then null else to_jsonb(v_existing) end,p_data);
  v_result:=jsonb_build_object('id',v_id,'version',coalesce(v_existing.version,0)+1);
  insert into app_requests(actor_id,request_id,fingerprint,result) values(p_actor,p_request,v_fingerprint,v_result);
  return v_result;
end $$;

-- Preserve settled history involving former participants.
create or replace function public.app_delete_expense(p_actor uuid, p_event uuid, p_expense uuid, p_version integer) returns boolean
language plpgsql set search_path = public as $$
declare v_expense expenses%rowtype;
begin
  perform 1 from events where id=p_event and not archived for update;
  if not found or not app_member(p_actor,p_event) then raise exception 'Forbidden'; end if;
  select * into v_expense from expenses where id=p_expense and event_id=p_event and deleted_at is null for update;
  if not found or (v_expense.author_id<>p_actor and not exists(select 1 from events where id=p_event and owner_id=p_actor)) then raise exception 'Forbidden'; end if;
  if not app_member(v_expense.payer_id,p_event) or exists(
    select 1 from expense_shares s where s.expense_id=p_expense and not app_member(s.user_id,p_event)
  ) then raise exception 'Расход связан с удалённым участником. Сначала пригласите его снова'; end if;
  if v_expense.version<>p_version then raise exception 'Version conflict'; end if;
  update expenses set deleted_at=now(),version=version+1 where id=p_expense;
  insert into change_history(event_id,actor_id,entity,entity_id,action,before_data)
    values(p_event,p_actor,'expense',p_expense,'Расход удалён',to_jsonb(v_expense));
  return true;
end $$;
