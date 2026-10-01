-- Run after all migrations. Test data and mutations are rolled back.
begin;
set local role service_role;
do $$
declare
  a uuid; b uuid; c uuid; outsider uuid;
  v_event uuid := gen_random_uuid();
  expense_id uuid := gen_random_uuid();
  transfer_id uuid := gen_random_uuid();
  old_hash text := md5(gen_random_uuid()::text);
  new_hash text := md5(gen_random_uuid()::text);
  data jsonb; before_snapshot jsonb; after_snapshot jsonb;
  test_telegram_id bigint := 7000000000000 + floor(random()*100000000000)::bigint;
begin
  a := app_login(test_telegram_id,'Тест создателя','','');
  b := app_login(test_telegram_id+1,'Тест участника','','');
  c := app_login(test_telegram_id+2,'Тест без расходов','','');
  outsider := app_login(test_telegram_id+3,'Тест постороннего','','');
  perform app_create_event(a,v_event,'Тест удаления участника','default');
  perform app_create_invite(a,v_event,old_hash);
  perform app_join_event(b,old_hash);
  perform app_join_event(c,old_hash);

  begin
    perform app_remove_participant(b,v_event,c);
    raise exception 'Non-owner removed participant';
  exception when others then
    if sqlerrm<>'Forbidden' then raise; end if;
  end;
  begin
    perform app_remove_participant(outsider,v_event,c);
    raise exception 'Outsider removed participant';
  exception when others then
    if sqlerrm<>'Forbidden' then raise; end if;
  end;
  begin
    perform app_remove_participant(a,v_event,a);
    raise exception 'Creator removed himself';
  exception when others then
    if sqlerrm<>'Создателя мероприятия нельзя удалить' then raise; end if;
  end;

  perform app_remove_participant(a,v_event,c);
  perform app_remove_participant(a,v_event,c);
  if app_member(c,v_event) then raise exception 'Empty participant retained access'; end if;
  if (select count(*) from change_history where event_id=v_event and entity_id=c and entity='participant')<>1 then raise exception 'Duplicate removal history'; end if;

  data := jsonb_build_object('id',expense_id,'title','Тест расхода','amount',10000,'category','food','date','2026-10-01','mode','equal','splits',jsonb_build_object(a::text,5000,b::text,5000));
  perform app_save_expense(a,v_event,data,gen_random_uuid(),null);
  begin
    perform app_remove_participant(a,v_event,b);
    raise exception 'Participant removed with debt';
  exception when others then
    if sqlerrm<>'Сначала завершите расчёты с участником' then raise; end if;
  end;
  perform app_create_transfer(b,v_event,transfer_id,a,5000,'2026-10-01');
  begin
    perform app_remove_participant(a,v_event,b);
    raise exception 'Participant removed with pending transfer';
  exception when others then
    if sqlerrm<>'Сначала подтвердите все переводы участника' then raise; end if;
  end;
  perform app_confirm_transfer(a,v_event,transfer_id);
  before_snapshot := app_snapshot(a)->0;
  perform app_remove_participant(a,v_event,b);
  after_snapshot := app_snapshot(a)->0;
  if app_member(b,v_event) then raise exception 'Removed participant retained access'; end if;
  if jsonb_array_length(app_snapshot(b))<>0 then raise exception 'Removed participant can read event'; end if;
  if before_snapshot->'expenses'<>after_snapshot->'expenses' or before_snapshot->'settlements'<>after_snapshot->'settlements' then raise exception 'Financial history changed'; end if;
  if app_balance(v_event,a)<>0 or app_balance(v_event,b)<>0 then raise exception 'Removal changed balances'; end if;
  if not exists(select 1 from jsonb_array_elements(after_snapshot->'members') m where m->>'id'=b::text and (m->>'removed')::boolean) then raise exception 'Former participant missing from history'; end if;

  begin
    perform app_save_expense(b,v_event,data,gen_random_uuid(),1);
    raise exception 'Removed participant changed expense';
  exception when others then
    if sqlerrm<>'Forbidden' then raise; end if;
  end;
  begin
    perform app_delete_expense(a,v_event,expense_id,1);
    raise exception 'Owner deleted settled history';
  exception when others then
    if sqlerrm<>'Расход связан с удалённым участником. Сначала пригласите его снова' then raise; end if;
  end;
  begin
    perform app_save_expense(a,v_event,data || jsonb_build_object('splits',jsonb_build_object(a::text,10000)),gen_random_uuid(),1);
    raise exception 'Owner rewrote former participant shares';
  exception when others then
    if sqlerrm<>'Расход связан с удалённым участником. Сначала пригласите его снова' then raise; end if;
  end;
  begin
    perform app_save_expense(a,v_event,data || jsonb_build_object('id',gen_random_uuid()),gen_random_uuid(),null);
    raise exception 'Former participant included in new expense';
  exception when others then
    if sqlerrm<>'Share belongs to outsider' then raise; end if;
  end;
  begin
    perform app_join_event(b,old_hash);
    raise exception 'Old invitation restored removed access';
  exception when others then
    if sqlerrm<>'Ссылка создана до удаления. Попросите создателя прислать новое приглашение' then raise; end if;
  end;
  perform app_create_invite(a,v_event,new_hash);
  perform app_join_event(b,new_hash);
  if not app_member(b,v_event) then raise exception 'New invitation did not restore membership'; end if;
  perform app_save_expense(a,v_event,data || jsonb_build_object('title','После приглашения'),gen_random_uuid(),1);

  perform app_set_archived(a,v_event,true);
  begin
    perform app_remove_participant(a,v_event,b);
    raise exception 'Removed participant from archived event';
  exception when others then
    if sqlerrm<>'Forbidden' then raise; end if;
  end;
  if has_function_privilege('anon','public.app_remove_participant(uuid,uuid,uuid)','execute') or
    has_function_privilege('authenticated','public.app_remove_participant(uuid,uuid,uuid)','execute') then raise exception 'Public removal RPC access'; end if;
end $$;
rollback;
