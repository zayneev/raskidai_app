-- Run after the migration on a disposable PostgreSQL database with Supabase roles.
begin;
set role service_role;
do $$
declare
  a uuid; b uuid; outsider uuid;
  event_id uuid := gen_random_uuid();
  expense_a uuid := gen_random_uuid();
  expense_b uuid := gen_random_uuid();
  transfer_id uuid := gen_random_uuid();
  request_id uuid := gen_random_uuid();
  invite_hash text := md5(gen_random_uuid()::text);
  data_a jsonb; data_b jsonb;
begin
  a := app_login(101,'Аня','','');
  b := app_login(202,'Борис','','');
  outsider := app_login(303,'Посторонний','','');
  perform app_create_event(a,event_id,'Поездка','default');
  if jsonb_array_length(app_snapshot(outsider))<>0 then raise exception 'Outsider can read'; end if;
  perform app_create_invite(a,event_id,invite_hash);
  perform app_join_event(b,invite_hash);
  if not app_member(b,event_id) then raise exception 'Invite failed'; end if;
  data_a := jsonb_build_object('id',expense_a,'title','Билеты','amount',10000,'category','transport','date','2026-09-29','mode','equal','splits',jsonb_build_object(a::text,5000,b::text,5000));
  data_b := jsonb_build_object('id',expense_b,'title','Ужин','amount',6000,'category','food','date','2026-09-29','mode','equal','splits',jsonb_build_object(a::text,3000,b::text,3000));
  perform app_save_expense(a,event_id,data_a || jsonb_build_object('payer',outsider),request_id,null);
  perform app_save_expense(a,event_id,data_a || jsonb_build_object('payer',outsider),request_id,null);
  if (select count(*) from expenses where id=expense_a)<>1 then raise exception 'Duplicate expense'; end if;
  if (select payer_id from expenses where id=expense_a)<>a then raise exception 'Forged payer accepted'; end if;
  begin
    perform app_save_expense(outsider,event_id,data_b,gen_random_uuid(),null);
    raise exception 'Outsider changed event';
  exception when others then
    if sqlerrm='Outsider changed event' then raise; end if;
  end;
  begin
    perform app_save_expense(a,event_id,data_b || jsonb_build_object('splits',jsonb_build_object(a::text,3000,outsider::text,3000)),gen_random_uuid(),null);
    raise exception 'Outsider added as share';
  exception when others then
    if sqlerrm='Outsider added as share' then raise; end if;
  end;
  perform app_save_expense(b,event_id,data_b,gen_random_uuid(),null);
  if app_balance(event_id,a)<>2000 or app_balance(event_id,b)<>-2000 then raise exception 'Incorrect balance before transfer'; end if;
  begin
    perform app_save_expense(b,event_id,data_a,gen_random_uuid(),1);
    raise exception 'Unauthorized edit';
  exception when others then
    if sqlerrm='Unauthorized edit' then raise; end if;
  end;
  perform app_create_transfer(b,event_id,transfer_id,a,2000,'2026-09-29');
  perform app_create_transfer(b,event_id,transfer_id,a,2000,'2026-09-29');
  if app_balance(event_id,b)<>-2000 or app_balance(event_id,b,true)<>0 then raise exception 'Pending transfer changed balance'; end if;
  begin
    perform app_confirm_transfer(b,event_id,transfer_id);
    raise exception 'Sender confirmed receipt';
  exception when others then
    if sqlerrm='Sender confirmed receipt' then raise; end if;
  end;
  perform app_confirm_transfer(a,event_id,transfer_id);
  perform app_confirm_transfer(a,event_id,transfer_id);
  if app_balance(event_id,a)<>0 or app_balance(event_id,b)<>0 then raise exception 'Confirmed balance failed'; end if;
  if (select count(*) from transfers where id=transfer_id)<>1 then raise exception 'Duplicate transfer'; end if;
  if (select count(*) from change_history where entity_id=transfer_id and action='Я получил')<>1 then raise exception 'Duplicate confirmation history'; end if;
  perform app_save_expense(a,event_id,data_b || jsonb_build_object('title','Ужин и чай'),gen_random_uuid(),1);
  if (select version from expenses where id=expense_b)<>2 then raise exception 'Owner edit failed'; end if;
  begin
    perform app_save_expense(b,event_id,data_b,gen_random_uuid(),1);
    raise exception 'Stale edit succeeded';
  exception when others then
    if sqlerrm='Stale edit succeeded' then raise; end if;
  end;
  begin
    perform app_set_archived(b,event_id,true);
    raise exception 'Non-owner archived';
  exception when others then
    if sqlerrm='Non-owner archived' then raise; end if;
  end;
  perform app_set_archived(a,event_id,true);
  if not (select archived from events where id=event_id) then raise exception 'Archive failed'; end if;
  perform app_set_archived(a,event_id,false);
  perform app_delete_expense(a,event_id,expense_b,2);
  begin
    perform app_set_archived(a,event_id,true);
    raise exception 'Archived with outstanding debt';
  exception when others then
    if sqlerrm='Archived with outstanding debt' then raise; end if;
  end;
  if has_table_privilege('anon','public.events','select') or has_table_privilege('authenticated','public.events','select') then raise exception 'Public table access'; end if;
  if has_function_privilege('anon','public.app_snapshot(uuid)','execute') then raise exception 'Public RPC access'; end if;
end $$;
rollback;
