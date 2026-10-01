-- Apply to a dedicated Supabase project. All application data is server-only.
create extension if not exists pgcrypto with schema extensions;

create table public.app_users (
  id uuid primary key default gen_random_uuid(), telegram_id bigint not null unique,
  first_name text not null, last_name text not null default '', username text not null default '',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.events (
  id uuid primary key, owner_id uuid not null references public.app_users(id),
  name text not null check (length(trim(name)) between 1 and 60),
  cover text not null default 'default', currency char(3) not null default 'RUB' check (currency = 'RUB'),
  archived boolean not null default false, created_at timestamptz not null default now()
);
create table public.event_participants (
  event_id uuid not null references public.events(id) on delete cascade,
  user_id uuid not null references public.app_users(id), joined_at timestamptz not null default now(),
  primary key (event_id, user_id)
);
create table public.event_invitations (
  id uuid primary key default gen_random_uuid(), event_id uuid not null references public.events(id) on delete cascade,
  token_hash text not null unique, created_by uuid not null references public.app_users(id),
  expires_at timestamptz not null, revoked_at timestamptz, created_at timestamptz not null default now()
);
create table public.expenses (
  id uuid primary key, event_id uuid not null references public.events(id) on delete cascade,
  author_id uuid not null references public.app_users(id), payer_id uuid not null references public.app_users(id),
  title text not null check (length(trim(title)) between 1 and 80),
  amount_cents bigint not null check (amount_cents > 0 and amount_cents <= 100000000000),
  category text not null check (category in ('home','transport','food','fun','other')),
  spent_on date not null, split_mode text not null check (split_mode in ('equal','percent','exact','shares')),
  version integer not null default 1, deleted_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index expenses_event_idx on public.expenses(event_id) where deleted_at is null;
create table public.expense_shares (
  expense_id uuid not null references public.expenses(id) on delete cascade,
  user_id uuid not null references public.app_users(id), amount_cents bigint not null check (amount_cents >= 0),
  primary key (expense_id, user_id)
);
create table public.transfers (
  id uuid primary key, event_id uuid not null references public.events(id) on delete cascade,
  sender_id uuid not null references public.app_users(id), recipient_id uuid not null references public.app_users(id),
  amount_cents bigint not null check (amount_cents > 0), transfer_on date not null,
  status text not null default 'pending' check (status in ('pending','confirmed')),
  confirmed_at timestamptz, created_at timestamptz not null default now(),
  check (sender_id <> recipient_id)
);
create index transfers_event_idx on public.transfers(event_id);
create table public.change_history (
  id bigint generated always as identity primary key, event_id uuid not null references public.events(id) on delete cascade,
  actor_id uuid not null references public.app_users(id), entity text not null,
  entity_id uuid not null, action text not null, before_data jsonb, after_data jsonb,
  happened_at timestamptz not null default now()
);
create index history_event_idx on public.change_history(event_id, happened_at desc);
create table public.app_requests (
  actor_id uuid not null references public.app_users(id), request_id uuid not null,
  fingerprint text not null, result jsonb not null, created_at timestamptz not null default now(),
  primary key (actor_id, request_id)
);

-- Public is normally an exposed schema. No browser role receives table or RPC access.
revoke all on public.app_users, public.events, public.event_participants, public.event_invitations,
  public.expenses, public.expense_shares, public.transfers, public.change_history, public.app_requests
  from anon, authenticated;
grant select, insert, update, delete on public.app_users, public.events, public.event_participants,
  public.event_invitations, public.expenses, public.expense_shares, public.transfers,
  public.change_history, public.app_requests to service_role;
alter table public.app_users enable row level security;
alter table public.events enable row level security;
alter table public.event_participants enable row level security;
alter table public.event_invitations enable row level security;
alter table public.expenses enable row level security;
alter table public.expense_shares enable row level security;
alter table public.transfers enable row level security;
alter table public.change_history enable row level security;
alter table public.app_requests enable row level security;

create function public.app_login(p_telegram_id bigint, p_first_name text, p_last_name text, p_username text)
returns uuid language sql set search_path = public as $$
  insert into app_users(telegram_id, first_name, last_name, username)
  values (p_telegram_id, left(p_first_name, 100), left(coalesce(p_last_name,''),100), left(coalesce(p_username,''),100))
  on conflict (telegram_id) do update set first_name = excluded.first_name,
    last_name = excluded.last_name, username = excluded.username, updated_at = now()
  returning id;
$$;

create function public.app_member(p_actor uuid, p_event uuid) returns boolean
language sql stable set search_path = public as $$
  select exists(select 1 from event_participants where event_id=p_event and user_id=p_actor);
$$;

create function public.app_balance(p_event uuid, p_user uuid, p_pending boolean default false)
returns bigint language sql stable set search_path = public as $$
  select coalesce((select sum(amount_cents) from expenses where event_id=p_event and payer_id=p_user and deleted_at is null),0)
       - coalesce((select sum(s.amount_cents) from expense_shares s join expenses e on e.id=s.expense_id where e.event_id=p_event and e.deleted_at is null and s.user_id=p_user),0)
       + coalesce((select sum(amount_cents) from transfers where event_id=p_event and sender_id=p_user and (status='confirmed' or p_pending)),0)
       - coalesce((select sum(amount_cents) from transfers where event_id=p_event and recipient_id=p_user and (status='confirmed' or p_pending)),0);
$$;

create function public.app_snapshot(p_actor uuid) returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',e.id,'name',e.name,'cover',e.cover,'archived',e.archived,'ownerId',e.owner_id,
    'members',(select coalesce(jsonb_agg(jsonb_build_object('id',u.id,'firstName',u.first_name,'lastName',u.last_name,'username',u.username) order by p.joined_at), '[]'::jsonb)
      from event_participants p join app_users u on u.id=p.user_id where p.event_id=e.id),
    'expenses',(select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'title',x.title,'amount',x.amount_cents,'payer',x.payer_id,'author',x.author_id,'category',x.category,'date',x.spent_on,'mode',x.split_mode,'version',x.version,
      'splits',(select coalesce(jsonb_object_agg(s.user_id,s.amount_cents),'{}'::jsonb) from expense_shares s where s.expense_id=x.id),
      'history',(select coalesce(jsonb_agg(h.action || ' пользователем: ' || u.first_name || ' ' || u.last_name order by h.happened_at),'[]'::jsonb) from change_history h join app_users u on u.id=h.actor_id where h.entity='expense' and h.entity_id=x.id)
    ) order by x.created_at desc),'[]'::jsonb) from expenses x where x.event_id=e.id and x.deleted_at is null),
    'settlements',(select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'from',t.sender_id,'to',t.recipient_id,'amount',t.amount_cents,'date',t.transfer_on,'status',t.status,'confirmedBy',case when t.status='confirmed' then t.recipient_id else null end) order by t.created_at desc),'[]'::jsonb) from transfers t where t.event_id=e.id)
  ) order by e.created_at desc),'[]'::jsonb)
  from events e where app_member(p_actor,e.id);
$$;

create function public.app_create_event(p_actor uuid, p_id uuid, p_name text, p_cover text) returns uuid
language plpgsql set search_path = public as $$
begin
  if length(trim(p_name)) not between 1 and 60 then raise exception 'Invalid event name'; end if;
  insert into events(id,owner_id,name,cover) values(p_id,p_actor,trim(p_name),left(p_cover,30)) on conflict (id) do nothing;
  if not exists(select 1 from events where id=p_id and owner_id=p_actor) then raise exception 'Event ID already used'; end if;
  insert into event_participants(event_id,user_id) values(p_id,p_actor) on conflict do nothing;
  return p_id;
end $$;

create function public.app_create_invite(p_actor uuid, p_event uuid, p_hash text) returns uuid
language plpgsql set search_path = public as $$
declare v_id uuid;
begin
  if not exists(select 1 from events where id=p_event and owner_id=p_actor and not archived) then raise exception 'Forbidden'; end if;
  insert into event_invitations(event_id,token_hash,created_by,expires_at)
  values(p_event,p_hash,p_actor,now()+interval '7 days') returning id into v_id;
  return v_id;
end $$;

create function public.app_join_event(p_actor uuid, p_hash text) returns uuid
language plpgsql set search_path = public as $$
declare v_event uuid;
begin
  select i.event_id into v_event from event_invitations i join events e on e.id=i.event_id
    where i.token_hash=p_hash and i.revoked_at is null and i.expires_at>now() and not e.archived;
  if v_event is null then raise exception 'Invitation expired or invalid'; end if;
  insert into event_participants(event_id,user_id) values(v_event,p_actor) on conflict do nothing;
  return v_event;
end $$;

create function public.app_save_expense(p_actor uuid, p_event uuid, p_data jsonb, p_request uuid, p_expected_version integer default null)
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

create function public.app_delete_expense(p_actor uuid, p_event uuid, p_expense uuid, p_version integer) returns boolean
language plpgsql set search_path = public as $$
declare v_expense expenses%rowtype;
begin
  perform 1 from events where id=p_event and not archived for update;
  if not found or not app_member(p_actor,p_event) then raise exception 'Forbidden'; end if;
  select * into v_expense from expenses where id=p_expense and event_id=p_event and deleted_at is null for update;
  if not found or (v_expense.author_id<>p_actor and not exists(select 1 from events where id=p_event and owner_id=p_actor)) then raise exception 'Forbidden'; end if;
  if v_expense.version<>p_version then raise exception 'Version conflict'; end if;
  update expenses set deleted_at=now(),version=version+1 where id=p_expense;
  insert into change_history(event_id,actor_id,entity,entity_id,action,before_data)
    values(p_event,p_actor,'expense',p_expense,'Расход удалён',to_jsonb(v_expense));
  return true;
end $$;

create function public.app_create_transfer(p_actor uuid, p_event uuid, p_id uuid, p_recipient uuid, p_amount bigint, p_date date) returns uuid
language plpgsql set search_path = public as $$
begin
  perform 1 from events where id=p_event and not archived for update;
  if not found or not app_member(p_actor,p_event) or not app_member(p_recipient,p_event) or p_actor=p_recipient then raise exception 'Forbidden'; end if;
  if exists(select 1 from transfers where id=p_id and event_id=p_event and sender_id=p_actor and recipient_id=p_recipient and amount_cents=p_amount) then return p_id; end if;
  if p_amount<=0 or p_amount>least(-app_balance(p_event,p_actor,true),app_balance(p_event,p_recipient,true)) then raise exception 'Transfer exceeds debt'; end if;
  insert into transfers(id,event_id,sender_id,recipient_id,amount_cents,transfer_on)
    values(p_id,p_event,p_actor,p_recipient,p_amount,p_date);
  insert into change_history(event_id,actor_id,entity,entity_id,action,after_data)
    values(p_event,p_actor,'transfer',p_id,'Я перевёл',jsonb_build_object('amount',p_amount,'recipient',p_recipient));
  return p_id;
end $$;

create function public.app_confirm_transfer(p_actor uuid, p_event uuid, p_id uuid) returns boolean
language plpgsql set search_path = public as $$
declare v_transfer transfers%rowtype;
begin
  perform 1 from events where id=p_event for update;
  if not found or not app_member(p_actor,p_event) then raise exception 'Forbidden'; end if;
  select * into v_transfer from transfers where id=p_id and event_id=p_event for update;
  if not found or v_transfer.recipient_id<>p_actor then raise exception 'Forbidden'; end if;
  if v_transfer.status='confirmed' then return true; end if;
  update transfers set status='confirmed',confirmed_at=now() where id=p_id;
  insert into change_history(event_id,actor_id,entity,entity_id,action,after_data)
    values(p_event,p_actor,'transfer',p_id,'Я получил',to_jsonb(v_transfer));
  return true;
end $$;

create function public.app_set_archived(p_actor uuid, p_event uuid, p_archived boolean) returns boolean
language plpgsql set search_path = public as $$
begin
  perform 1 from events where id=p_event and owner_id=p_actor for update;
  if not found then raise exception 'Forbidden'; end if;
  if p_archived and (exists(select 1 from transfers where event_id=p_event and status='pending') or
      exists(select 1 from event_participants where event_id=p_event and app_balance(p_event,user_id)<>0)) then raise exception 'Balances outstanding'; end if;
  update events set archived=p_archived where id=p_event;
  insert into change_history(event_id,actor_id,entity,entity_id,action,after_data)
    values(p_event,p_actor,'event',p_event,case when p_archived then 'Архивировано' else 'Возобновлено' end,jsonb_build_object('archived',p_archived));
  return true;
end $$;

revoke all on function public.app_login(bigint,text,text,text), public.app_member(uuid,uuid),
  public.app_balance(uuid,uuid,boolean), public.app_snapshot(uuid),
  public.app_create_event(uuid,uuid,text,text), public.app_create_invite(uuid,uuid,text),
  public.app_join_event(uuid,text), public.app_save_expense(uuid,uuid,jsonb,uuid,integer),
  public.app_delete_expense(uuid,uuid,uuid,integer),
  public.app_create_transfer(uuid,uuid,uuid,uuid,bigint,date),
  public.app_confirm_transfer(uuid,uuid,uuid), public.app_set_archived(uuid,uuid,boolean)
  from public, anon, authenticated;
grant execute on function public.app_login(bigint,text,text,text), public.app_member(uuid,uuid),
  public.app_balance(uuid,uuid,boolean), public.app_snapshot(uuid),
  public.app_create_event(uuid,uuid,text,text), public.app_create_invite(uuid,uuid,text),
  public.app_join_event(uuid,text), public.app_save_expense(uuid,uuid,jsonb,uuid,integer),
  public.app_delete_expense(uuid,uuid,uuid,integer),
  public.app_create_transfer(uuid,uuid,uuid,uuid,bigint,date),
  public.app_confirm_transfer(uuid,uuid,uuid), public.app_set_archived(uuid,uuid,boolean)
  to service_role;
