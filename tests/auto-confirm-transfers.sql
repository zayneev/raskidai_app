-- Run after all migrations on a disposable PostgreSQL database with Supabase roles.
begin;
do $$
begin
  if (select count(*) from cron.job where jobname='auto-confirm-transfers' and schedule='* * * * *' and active
      and command='select public.app_auto_confirm_transfers()')<>1 then raise exception 'Missing automatic confirmation schedule'; end if;
end $$;
set role service_role;
do $$
declare
  a uuid; b uuid;
  v_event uuid := gen_random_uuid();
  v_overdue uuid := gen_random_uuid();
  v_boundary uuid := gen_random_uuid();
  v_young uuid := gen_random_uuid();
  v_manual uuid := gen_random_uuid();
  v_snapshot jsonb;
begin
  a := app_login(-91001,'Получатель','','');
  b := app_login(-91002,'Отправитель','','');
  perform app_create_event(a,v_event,'Автоподтверждение','default');
  insert into event_participants(event_id,user_id) values(v_event,b);
  perform app_save_expense(a,v_event,jsonb_build_object(
    'id',gen_random_uuid(),'title','Общий расход','amount',10000,'category','other',
    'date',current_date,'mode','exact','splits',jsonb_build_object(b::text,10000)
  ),gen_random_uuid(),null);
  perform app_create_transfer(b,v_event,v_overdue,a,2000,current_date+7);
  perform app_create_transfer(b,v_event,v_boundary,a,3000,current_date+7);
  perform app_create_transfer(b,v_event,v_young,a,1000,current_date-30);
  perform app_create_transfer(b,v_event,v_manual,a,4000,current_date);
  update transfers set created_at=now()-interval '25 hours' where id in (v_overdue,v_manual);
  update transfers set created_at=now()-interval '24 hours' where id=v_boundary;
  update transfers set created_at=now()-interval '24 hours'+interval '1 second' where id=v_young;

  -- A retry must not restart the deadline, even with a different transfer date.
  perform app_create_transfer(b,v_event,v_overdue,a,2000,current_date);
  if (select created_at from transfers where id=v_overdue)<>now()-interval '25 hours' then raise exception 'Retry reset deadline'; end if;
  perform app_confirm_transfer(a,v_event,v_manual);
  if app_balance(v_event,b)<>-6000 then raise exception 'Pending transfer changed balance'; end if;

  perform app_auto_confirm_transfers();
  if exists(select 1 from transfers where id in (v_overdue,v_boundary) and (status<>'confirmed' or not confirmed_automatically or confirmed_at is null)) then
    raise exception 'Overdue or exact-boundary transfer not confirmed';
  end if;
  if (select status from transfers where id=v_young)<>'pending' then raise exception 'User-selected date caused early confirmation'; end if;
  if app_balance(v_event,b)<>-1000 or app_balance(v_event,a)<>1000 then raise exception 'Automatic balance incorrect'; end if;
  if (select confirmed_automatically from transfers where id=v_manual) then raise exception 'Manual confirmation overwritten'; end if;
  if (select count(*) from change_history where entity_id in (v_overdue,v_boundary) and action='Подтверждено автоматически'
      and (after_data->>'confirmed_automatically')::boolean and after_data->>'status'='confirmed')<>2 then raise exception 'Missing automatic audit history'; end if;

  -- A late recipient click and repeated worker runs are idempotent.
  perform app_confirm_transfer(a,v_event,v_overdue);
  perform app_auto_confirm_transfers();
  if (select count(*) from change_history where entity_id in (v_overdue,v_boundary) and action='Подтверждено автоматически')<>2 then raise exception 'Duplicate automatic history'; end if;
  if exists(select 1 from change_history where entity_id=v_overdue and action='Я получил') then raise exception 'Automatic receipt attributed to recipient'; end if;
  v_snapshot := (select item from jsonb_array_elements(app_snapshot(a)) item where item->>'id'=v_event::text);
  if not exists(select 1 from jsonb_array_elements(v_snapshot->'settlements') s where s->>'id'=v_overdue::text
      and (s->>'confirmedAutomatically')::boolean and s->'confirmedBy'='null'::jsonb and s->>'createdAt' is not null) then raise exception 'Automatic confirmation missing from snapshot'; end if;
  if not exists(select 1 from jsonb_array_elements(v_snapshot->'settlements') s where s->>'id'=v_manual::text and s->>'confirmedBy'=a::text) then raise exception 'Manual recipient missing from snapshot'; end if;

  perform app_confirm_transfer(a,v_event,v_young);
  perform app_auto_confirm_transfers();
  if app_balance(v_event,b)<>0 or app_balance(v_event,a)<>0 then raise exception 'Final balance incorrect'; end if;
  if (select count(*) from change_history where entity_id=v_young and action='Я получил')<>1 then raise exception 'Manual confirmation changed'; end if;
  perform app_set_archived(a,v_event,true);
  if not (select archived from events where id=v_event) then raise exception 'Automatic settlement blocks archive'; end if;
  if has_function_privilege('anon','public.app_auto_confirm_transfers()','execute')
     or has_function_privilege('authenticated','public.app_auto_confirm_transfers()','execute') then raise exception 'Public access to worker'; end if;
end $$;
rollback;
