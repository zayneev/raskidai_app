-- Accounting participants may exist before accepting access to an event.
alter table public.event_participants add column membership_status text not null default 'joined'
  check (membership_status in ('invited','joined'));
alter table public.event_participants add column invited_at timestamptz not null default now();
alter table public.event_participants alter column joined_at drop not null;
alter table public.app_users add column can_message boolean not null default false;

create function public.app_participant(p_actor uuid, p_event uuid) returns boolean
language sql stable set search_path = public as $$
  select exists(select 1 from event_participants where event_id=p_event and user_id=p_actor and removed_at is null);
$$;

create or replace function public.app_member(p_actor uuid, p_event uuid) returns boolean
language sql stable set search_path = public as $$
  select exists(select 1 from event_participants where event_id=p_event and user_id=p_actor
    and removed_at is null and membership_status='joined');
$$;

create table public.telegram_member_requests (
  request_id integer primary key check (request_id>0),
  actor_id uuid not null references public.app_users(id),
  event_id uuid not null references public.events(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now()+interval '15 minutes',
  processed_at timestamptz,
  result jsonb
);
create index telegram_member_requests_actor_created_idx on public.telegram_member_requests(actor_id,created_at);
create index telegram_member_requests_event_idx on public.telegram_member_requests(event_id);
alter table public.telegram_member_requests enable row level security;
revoke all on public.telegram_member_requests from public, anon, authenticated;
grant select, insert, update, delete on public.telegram_member_requests to service_role;

create function public.app_set_telegram_write_access(p_actor uuid, p_allowed boolean) returns void
language sql set search_path = public as $$
  update app_users set can_message=p_allowed where id=p_actor;
$$;

create function public.app_create_member_request(p_actor uuid, p_event uuid, p_request integer) returns bigint
language plpgsql set search_path = public as $$
declare v_telegram bigint;
begin
  perform 1 from events where id=p_event and owner_id=p_actor and not archived for update;
  if not found or not app_member(p_actor,p_event) then raise exception 'Forbidden'; end if;
  if (select count(*) from telegram_member_requests where actor_id=p_actor and created_at>now()-interval '1 minute')>=5 then
    raise exception 'Слишком много запросов. Попробуйте через минуту';
  end if;
  insert into telegram_member_requests(request_id,actor_id,event_id) values(p_request,p_actor,p_event);
  select telegram_id into v_telegram from app_users where id=p_actor;
  return v_telegram;
end $$;

create function public.app_complete_member_request(p_sender bigint, p_request integer, p_users jsonb) returns boolean
language plpgsql set search_path = public as $$
declare
  v_request telegram_member_requests%rowtype;
  v_user record; v_id uuid; v_inserted uuid;
  v_members uuid[] := '{}'; v_added integer := 0; v_skipped integer := 0;
begin
  select r.* into v_request from telegram_member_requests r join app_users u on u.id=r.actor_id
    where r.request_id=p_request and u.telegram_id=p_sender;
  if not found then return false; end if;
  -- Event first, request second: use the same locking order as expenses and removals.
  perform 1 from events where id=v_request.event_id and owner_id=v_request.actor_id and not archived for update;
  if not found or not app_member(v_request.actor_id,v_request.event_id) then return false; end if;
  select * into v_request from telegram_member_requests where request_id=p_request for update;
  if v_request.processed_at is not null then return true; end if;
  if v_request.expires_at<=now() then return false; end if;
  if p_users is null or jsonb_typeof(p_users)<>'array' or jsonb_array_length(p_users) not between 1 and 10 then raise exception 'Invalid shared users'; end if;
  if exists(select 1 from jsonb_to_recordset(p_users) as u(user_id bigint) where user_id is null or user_id<=0 or user_id>4503599627370495) or
      (select count(distinct user_id) from jsonb_to_recordset(p_users) as u(user_id bigint))<>jsonb_array_length(p_users) then raise exception 'Invalid shared users'; end if;
  for v_user in select * from jsonb_to_recordset(p_users) as u(user_id bigint,first_name text,last_name text,username text) order by user_id loop
    v_id := null; v_inserted := null;
    insert into app_users(telegram_id,first_name,last_name,username)
      values(v_user.user_id,left(coalesce(nullif(trim(v_user.first_name),''),'Участник Telegram'),100),left(coalesce(v_user.last_name,''),100),left(coalesce(v_user.username,''),100))
      on conflict(telegram_id) do nothing returning id into v_id;
    if v_id is null then select id into v_id from app_users where telegram_id=v_user.user_id; end if;
    insert into event_participants(event_id,user_id,membership_status,joined_at)
      values(v_request.event_id,v_id,'invited',null) on conflict(event_id,user_id) do nothing returning user_id into v_inserted;
    if v_inserted is not null then
      v_added := v_added+1;
      insert into change_history(event_id,actor_id,entity,entity_id,action,after_data)
        values(v_request.event_id,v_request.actor_id,'participant',v_id,'Участник добавлен до присоединения',jsonb_build_object('userId',v_id));
    end if;
    -- Selecting an existing member is harmless. Removed users retain their access cutoff;
    -- only accepting a fresh link may restore their membership.
    if exists(select 1 from event_participants where event_id=v_request.event_id and user_id=v_id and removed_at is null and membership_status='invited') then
      v_members := array_append(v_members,v_id);
    else v_skipped := v_skipped+1;
    end if;
  end loop;
  update telegram_member_requests set processed_at=clock_timestamp(),
    result=jsonb_build_object('memberIds',to_jsonb(v_members),'addedCount',v_added,'skippedCount',v_skipped)
    where request_id=p_request;
  return true;
end $$;

create function public.app_member_request_result(p_actor uuid, p_event uuid, p_request integer) returns jsonb
language plpgsql set search_path = public as $$
declare v_request telegram_member_requests%rowtype;
begin
  if not exists(select 1 from events where id=p_event and owner_id=p_actor) or not app_member(p_actor,p_event) then raise exception 'Forbidden'; end if;
  select * into v_request from telegram_member_requests where request_id=p_request and event_id=p_event and actor_id=p_actor;
  if not found then raise exception 'Forbidden'; end if;
  if v_request.processed_at is not null then return v_request.result || jsonb_build_object('status','completed'); end if;
  return jsonb_build_object('status',case when v_request.expires_at<=now() then 'expired' else 'pending' end);
end $$;

create function public.app_participant_invite_context(p_actor uuid, p_event uuid, p_members uuid[]) returns jsonb
language plpgsql set search_path = public as $$
declare v_name text; v_telegram bigint;
begin
  select e.name,u.telegram_id into v_name,v_telegram from events e join app_users u on u.id=p_actor
    where e.id=p_event and e.owner_id=p_actor and not e.archived;
  if not found or not app_member(p_actor,p_event) then raise exception 'Forbidden'; end if;
  if p_members is null or cardinality(p_members)>10 or exists(select 1 from unnest(p_members) as m(id) where not app_participant(m.id,p_event)) then raise exception 'Forbidden'; end if;
  return jsonb_build_object('telegramId',v_telegram,'eventName',v_name,'members',(
    select coalesce(jsonb_agg(jsonb_build_object('id',u.id,'name',trim(u.first_name || ' ' || u.last_name),'telegramId',u.telegram_id,'canMessage',u.can_message)),'[]'::jsonb)
    from app_users u where u.id=any(p_members)
  ));
end $$;

create function public.app_preview_invite(p_actor uuid, p_hash text) returns jsonb
language plpgsql stable set search_path = public as $$
declare v_event events%rowtype; v_owner text; v_created timestamptz; v_removed timestamptz;
begin
  select e.id,e.owner_id,e.name,e.cover,e.currency,e.archived,e.created_at,i.created_at into v_event.id,v_event.owner_id,v_event.name,v_event.cover,v_event.currency,v_event.archived,v_event.created_at,v_created
    from event_invitations i join events e on e.id=i.event_id where i.token_hash=p_hash
      and i.revoked_at is null and i.expires_at>now() and not e.archived;
  if not found then raise exception 'Приглашение недействительно или срок его действия истёк'; end if;
  select removed_at into v_removed from event_participants where event_id=v_event.id and user_id=p_actor;
  if v_removed is not null and v_created<=v_removed then raise exception 'Ссылка создана до удаления. Попросите создателя прислать новое приглашение'; end if;
  select trim(first_name || ' ' || last_name) into v_owner from app_users where id=v_event.owner_id;
  return jsonb_build_object('id',v_event.id,'name',v_event.name,'cover',v_event.cover,'ownerName',v_owner,
    'memberCount',(select count(*) from event_participants where event_id=v_event.id and removed_at is null),
    'personalShare',(select coalesce(sum(s.amount_cents),0) from expense_shares s join expenses e on e.id=s.expense_id where e.event_id=v_event.id and e.deleted_at is null and s.user_id=p_actor),
    'joined',app_member(p_actor,v_event.id));
end $$;

create or replace function public.app_join_event(p_actor uuid, p_hash text) returns uuid
language plpgsql set search_path = public as $$
declare v_event uuid; v_invited_at timestamptz; v_removed_at timestamptz;
begin
  select event_id into v_event from event_invitations where token_hash=p_hash;
  if v_event is null then raise exception 'Invitation expired or invalid'; end if;
  perform 1 from events where id=v_event and not archived for update;
  if not found then raise exception 'Invitation expired or invalid'; end if;
  select created_at into v_invited_at from event_invitations where token_hash=p_hash and revoked_at is null and expires_at>now();
  if not found then raise exception 'Invitation expired or invalid'; end if;
  select removed_at into v_removed_at from event_participants where event_id=v_event and user_id=p_actor;
  if v_removed_at is not null and v_invited_at<=v_removed_at then
    raise exception 'Ссылка создана до удаления. Попросите создателя прислать новое приглашение';
  end if;
  insert into event_participants(event_id,user_id,joined_at,membership_status) values(v_event,p_actor,clock_timestamp(),'joined')
    on conflict(event_id,user_id) do update set removed_at=null,membership_status='joined',joined_at=clock_timestamp()
    where event_participants.removed_at is not null or event_participants.membership_status='invited';
  return v_event;
end $$;

revoke all on function public.app_participant(uuid,uuid), public.app_set_telegram_write_access(uuid,boolean),
  public.app_create_member_request(uuid,uuid,integer), public.app_complete_member_request(bigint,integer,jsonb),
  public.app_member_request_result(uuid,uuid,integer), public.app_participant_invite_context(uuid,uuid,uuid[]), public.app_preview_invite(uuid,text)
  from public, anon, authenticated;
grant execute on function public.app_participant(uuid,uuid), public.app_set_telegram_write_access(uuid,boolean),
  public.app_create_member_request(uuid,uuid,integer), public.app_complete_member_request(bigint,integer,jsonb),
  public.app_member_request_result(uuid,uuid,integer), public.app_participant_invite_context(uuid,uuid,uuid[]), public.app_preview_invite(uuid,text)
  to service_role;

-- Share validation includes invited participants; author access still requires acceptance.
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
    if not app_participant(v_existing.payer_id,p_event) or exists(
      select 1 from expense_shares s where s.expense_id=v_id and not app_participant(s.user_id,p_event)
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
    if not app_participant(v_share.key::uuid,p_event) then raise exception 'Share belongs to outsider'; end if;
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

create or replace function public.app_delete_expense(p_actor uuid, p_event uuid, p_expense uuid, p_version integer) returns boolean
language plpgsql set search_path = public as $$
declare v_expense expenses%rowtype;
begin
  perform 1 from events where id=p_event and not archived for update;
  if not found or not app_member(p_actor,p_event) then raise exception 'Forbidden'; end if;
  select * into v_expense from expenses where id=p_expense and event_id=p_event and deleted_at is null for update;
  if not found or (v_expense.author_id<>p_actor and not exists(select 1 from events where id=p_event and owner_id=p_actor)) then raise exception 'Forbidden'; end if;
  if not app_participant(v_expense.payer_id,p_event) or exists(
    select 1 from expense_shares s where s.expense_id=p_expense and not app_participant(s.user_id,p_event)
  ) then raise exception 'Расход связан с удалённым участником. Сначала пригласите его снова'; end if;
  if v_expense.version<>p_version then raise exception 'Version conflict'; end if;
  update expenses set deleted_at=now(),version=version+1 where id=p_expense;
  insert into change_history(event_id,actor_id,entity,entity_id,action,before_data)
    values(p_event,p_actor,'expense',p_expense,'Расход удалён',to_jsonb(v_expense));
  return true;
end $$;

create or replace function public.app_snapshot(p_actor uuid) returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',e.id,'name',e.name,'cover',e.cover,'archived',e.archived,'ownerId',e.owner_id,
    'members',(select coalesce(jsonb_agg(jsonb_build_object('id',u.id,'firstName',u.first_name,'lastName',u.last_name,'username',u.username,'removed',p.removed_at is not null,'status',p.membership_status) order by coalesce(p.joined_at,p.invited_at),p.user_id), '[]'::jsonb)
      from event_participants p join app_users u on u.id=p.user_id where p.event_id=e.id),
    'expenses',(select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'title',x.title,'amount',x.amount_cents,'payer',x.payer_id,'author',x.author_id,'category',x.category,'date',x.spent_on,'mode',x.split_mode,'version',x.version,
      'splits',(select coalesce(jsonb_object_agg(s.user_id,s.amount_cents),'{}'::jsonb) from expense_shares s where s.expense_id=x.id),
      'history',(select coalesce(jsonb_agg(h.action || ' пользователем: ' || u.first_name || ' ' || u.last_name order by h.happened_at),'[]'::jsonb) from change_history h join app_users u on u.id=h.actor_id where h.entity='expense' and h.entity_id=x.id)
    ) order by x.created_at desc),'[]'::jsonb) from expenses x where x.event_id=e.id and x.deleted_at is null),
    'settlements',(select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'from',t.sender_id,'to',t.recipient_id,'amount',t.amount_cents,'date',t.transfer_on,'createdAt',t.created_at,'status',t.status,
      'confirmedBy',case when t.status='confirmed' and not t.confirmed_automatically then t.recipient_id else null end,
      'confirmedAutomatically',t.confirmed_automatically) order by t.created_at desc),'[]'::jsonb) from transfers t where t.event_id=e.id)
  ) order by e.created_at desc),'[]'::jsonb)
  from events e where app_member(p_actor,e.id);
$$;
