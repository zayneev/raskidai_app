-- Run after all migrations. Every fixture and mutation is rolled back.
begin;
set local role service_role;
do $$
declare
  a uuid; b uuid; c uuid; v_event uuid := gen_random_uuid();
  v_expense uuid := gen_random_uuid(); v_request integer := 123456789;
  v_hash text := md5(gen_random_uuid()::text); v_before jsonb; v_preview jsonb;
  v_telegram bigint := 7000000000000+floor(random()*100000000000)::bigint;
  v_users jsonb; v_data jsonb;
begin
  a := app_login(v_telegram,'Создатель','','');
  c := app_login(v_telegram+2,'Посторонний','','');
  perform app_create_event(a,v_event,'Приглашённые участники','mountains');
  if app_create_member_request(a,v_event,v_request)<>v_telegram then raise exception 'Wrong requesting identity'; end if;
  v_users := jsonb_build_array(jsonb_build_object('user_id',v_telegram+1,'first_name','Маша','last_name','Тест','username','masha'));
  if app_complete_member_request(v_telegram+2,v_request,v_users) then raise exception 'Another sender completed the request'; end if;
  if not app_complete_member_request(v_telegram,v_request,v_users) then raise exception 'Request not completed'; end if;
  select id into b from app_users where telegram_id=v_telegram+1;
  if b is null or not app_participant(b,v_event) or app_member(b,v_event) then raise exception 'Invited identity or access incorrect'; end if;
  if jsonb_array_length(app_snapshot(b))<>0 then raise exception 'Invited user can read event'; end if;
  if (app_member_request_result(a,v_event,v_request)->>'addedCount')::integer<>1 then raise exception 'Wrong result'; end if;
  if not exists(select 1 from jsonb_array_elements(app_snapshot(a)->0->'members') m where m->>'id'=b::text and m->>'status'='invited') then raise exception 'Missing invited status'; end if;
  -- Duplicate webhook delivery cannot create another member, overwrite a name, or add another user.
  perform app_complete_member_request(v_telegram,v_request,jsonb_build_array(jsonb_build_object('user_id',v_telegram+3,'first_name','Другой')));
  if (select count(*) from event_participants where event_id=v_event)<>2 then raise exception 'Duplicate webhook changed members'; end if;
  if (select count(*) from change_history where event_id=v_event and entity='participant')<>1 then raise exception 'Duplicate member history'; end if;
  begin
    perform app_create_member_request(c,v_event,v_request+1);
    raise exception 'Outsider can request users';
  exception when others then if sqlerrm<>'Forbidden' then raise; end if; end;
  begin
    perform app_member_request_result(c,v_event,v_request);
    raise exception 'Outsider can read request';
  exception when others then if sqlerrm<>'Forbidden' then raise; end if; end;
  v_data := jsonb_build_object('id',v_expense,'title','Жильё','amount',900000,'category','home','date',current_date,'mode','equal','splits',jsonb_build_object(a::text,450000,b::text,450000));
  perform app_save_expense(a,v_event,v_data,gen_random_uuid(),null);
  perform app_save_expense(a,v_event,v_data||jsonb_build_object('title','Жильё после правки'),gen_random_uuid(),1);
  if app_balance(v_event,b)<>-450000 then raise exception 'Invited share missing'; end if;
  begin
    perform app_save_expense(b,v_event,v_data||jsonb_build_object('id',gen_random_uuid()),gen_random_uuid(),null);
    raise exception 'Invited user can create expenses';
  exception when others then if sqlerrm<>'Forbidden' then raise; end if; end;
  begin
    perform app_create_transfer(b,v_event,gen_random_uuid(),a,450000,current_date);
    raise exception 'Invited user can settle';
  exception when others then if sqlerrm<>'Forbidden' then raise; end if; end;
  perform app_create_invite(a,v_event,v_hash);
  v_preview := app_preview_invite(b,v_hash);
  if (v_preview->>'personalShare')::bigint<>450000 or (v_preview->>'joined')::boolean then raise exception 'Wrong invitation preview'; end if;
  if v_preview ? 'members' or v_preview ? 'expenses' then raise exception 'Preview leaks event details'; end if;
  if (app_preview_invite(c,v_hash)->>'personalShare')::bigint<>0 then raise exception 'Preview leaks another balance'; end if;
  v_before := app_snapshot(a)->0->'expenses';
  if app_login(v_telegram+1,'Мария','Новая','renamed')<>b then raise exception 'Login created a duplicate identity'; end if;
  perform app_join_event(b,v_hash);
  perform app_join_event(b,v_hash);
  if not app_member(b,v_event) then raise exception 'Acceptance did not grant access'; end if;
  if (select count(*) from event_participants where event_id=v_event and user_id=b)<>1 then raise exception 'Acceptance duplicated participant'; end if;
  if app_balance(v_event,b)<>-450000 or app_snapshot(a)->0->'expenses'<>v_before then raise exception 'Acceptance changed financial history'; end if;
  if not (app_preview_invite(b,v_hash)->>'joined')::boolean then raise exception 'Acceptance missing from preview'; end if;
  perform app_create_member_request(a,v_event,v_request+1);
  update telegram_member_requests set expires_at=now()-interval '1 second' where request_id=v_request+1;
  if app_complete_member_request(v_telegram,v_request+1,v_users) then raise exception 'Expired request completed'; end if;
  if app_member_request_result(a,v_event,v_request+1)->>'status'<>'expired' then raise exception 'Expired status missing'; end if;
  if has_function_privilege('anon','public.app_complete_member_request(bigint,integer,jsonb)','execute') or
    has_function_privilege('authenticated','public.app_preview_invite(uuid,text)','execute') or
    has_table_privilege('anon','public.telegram_member_requests','select') then raise exception 'Public access to privileged member functions'; end if;
end $$;
rollback;
