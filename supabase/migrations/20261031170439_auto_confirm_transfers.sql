-- Use the server-recorded submission time, never the user-selected transfer_on date.
alter table public.transfers add column confirmed_automatically boolean not null default false
  check (not confirmed_automatically or status='confirmed');
create index transfers_pending_created_idx on public.transfers(created_at, event_id) where status='pending';

create function public.app_auto_confirm_transfers() returns integer
language plpgsql set search_path = public as $$
declare
  v_event uuid;
  v_cutoff timestamptz := now() - interval '24 hours';
  v_count integer := 0;
  v_updated integer;
begin
  -- Match the event-first locking order used by manual confirmations and expense edits.
  -- Busy events are retried on the next run; concurrent workers cannot confirm twice.
  for v_event in
    select e.id from events e where e.id in (
      select t.event_id from transfers t where t.status='pending' and t.created_at<=v_cutoff
    ) order by e.id for update of e skip locked
  loop
    with confirmed as (
      update transfers set status='confirmed', confirmed_at=now(), confirmed_automatically=true
      where event_id=v_event and status='pending' and created_at<=v_cutoff
      returning *
    )
    insert into change_history(event_id,actor_id,entity,entity_id,action,after_data)
      -- The sender initiated this operation; do not attribute a manual receipt to the recipient.
      select event_id,sender_id,'transfer',id,'Подтверждено автоматически',to_jsonb(confirmed) from confirmed;
    get diagnostics v_updated = row_count;
    v_count := v_count + v_updated;
  end loop;
  return v_count;
end $$;

revoke all on function public.app_auto_confirm_transfers() from public, anon, authenticated;
grant execute on function public.app_auto_confirm_transfers() to service_role;

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
    'settlements',(select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'from',t.sender_id,'to',t.recipient_id,'amount',t.amount_cents,'date',t.transfer_on,'createdAt',t.created_at,'status',t.status,
      'confirmedBy',case when t.status='confirmed' and not t.confirmed_automatically then t.recipient_id else null end,
      'confirmedAutomatically',t.confirmed_automatically) order by t.created_at desc),'[]'::jsonb) from transfers t where t.event_id=e.id)
  ) order by e.created_at desc),'[]'::jsonb)
  from events e where app_member(p_actor,e.id);
$$;

-- Runs without an open app, including for transfers already overdue when this is applied.
create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule('auto-confirm-transfers', '* * * * *', 'select public.app_auto_confirm_transfers()');
