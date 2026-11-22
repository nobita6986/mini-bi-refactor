import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { runWp5Cutover } from './wp5-cutover-role-access.mjs';
import { migrationSqlForTransaction, PR28_CLEANUP_MIGRATION_NAME, PR28_PERMISSION_GROUPS_FOUNDATION_MIGRATION_NAME, S0_T1_C_MIGRATION_NAME, verifyS0T1CSecurityPostconditions } from './lib/migration-validation.mjs';

const admins=['nobita6986@gmail.com','luanpt@hrpartner.vn','lienvu@hrpartner.vn','ngattt@hrpartner.vn'].map((email,i)=>({auth:`19002370-0000-4000-8000-${String(i+1).padStart(12,'0')}`,app:`29002370-0000-4000-8000-${String(i+1).padStart(12,'0')}`,email}));
const targets=[
  {app:'6772d4bb-edd6-4a7d-9092-621d37d072a7',auth:'19002370-0000-4000-8000-000000000011',recruiter:'39002370-0000-4000-8000-000000000011',name:'Marketing Vĩnh Phúc'},
  {app:'b206918e-38ae-482e-b3f2-0e96593655dc',auth:'19002370-0000-4000-8000-000000000012',recruiter:'39002370-0000-4000-8000-000000000012',name:'Marketing Bắc Giang'},
];

test('PR28 approved Marketing retirement: fresh, absent, already retired and fail-closed data states',async t=>{
  const dir=path.resolve('supabase/migrations');
  const names=(await readdir(dir)).filter(n=>n.endsWith('.sql')).sort();
  const groupIndex=names.indexOf(PR28_PERMISSION_GROUPS_FOUNDATION_MIGRATION_NAME), cleanupIndex=names.indexOf(PR28_CLEANUP_MIGRATION_NAME);
  assert.ok(groupIndex>0&&cleanupIndex>groupIndex);
  const cleanup=await readFile(path.join(dir,PR28_CLEANUP_MIGRATION_NAME),'utf8');
  const start=cleanup.indexOf('-- Owner decision 2026-11-22:'),end=cleanup.indexOf('$pr28_retire_marketing$;',start);
  assert.ok(start>0&&end>start,'approved retirement must precede existing cleanup gates');
  const prefix=cleanup.slice(start,end+'$pr28_retire_marketing$;'.length),body=migrationSqlForTransaction(cleanup);
  const db=new PGlite();
  async function state(){return (await db.query(`select u.app_user_id,u.enabled,u.version,(select count(*)::int from public.leave_employee_profiles p where p.app_user_id=u.app_user_id) as profiles,(select count(*)::int from public.leave_audit_events a where a.target_app_user_id=u.app_user_id and a.event_type='EMPLOYEE_PROFILE_RETIRED') as archives from public.direct_entry_app_users u where u.app_user_id=any($1::uuid[]) order by u.app_user_id`,[targets.map(x=>x.app)])).rows;}
  async function seed(){
    for(const u of targets){
      await db.query('insert into auth.users(id,email) values($1::uuid,$2)',[u.auth,u.name.replaceAll(' ','')+'@fixture.local']);
      await db.query('insert into public.direct_entry_app_users(app_user_id,auth_subject,display_name,enabled,authz_managed,version) values($1::uuid,$2::uuid,$3,true,true,2)',[u.app,u.auth,u.name]);
      await db.query("insert into public.authz_account_role_assignments(app_user_id,role_code,scope_kind,source_kind,reason,assigned_by_app_user_id) values($1::uuid,'EMPLOYEE_BASE','GLOBAL','BACKFILL_SNAPSHOT','fixture',$2::uuid),($1::uuid,'RECRUITER','GLOBAL','BACKFILL_SNAPSHOT','fixture',$2::uuid)",[u.app,admins[0].app]);
      await db.query('insert into public.recruiters(recruiter_id,display_name,active) values($1::uuid,$2,true)',[u.recruiter,u.name]);
      await db.query("insert into public.recruiter_provider_memberships(recruiter_id,provider_type,valid_from,is_current) values($1::uuid,'hrp','2020-01-01',true)",[u.recruiter]);
      await db.query("insert into public.direct_entry_app_user_recruiter_links(app_user_id,recruiter_id,verified,valid_from,is_current) values($1::uuid,$2::uuid,true,'2020-01-01',true)",[u.app,u.recruiter]);
      await db.query("insert into public.leave_employee_profiles(app_user_id,is_shared_non_employee,employment_status,unit_kind,updated_by_app_user_id) values($1::uuid,true,'UNCONFIGURED','UNCLASSIFIED',$2::uuid)",[u.app,admins[0].app]);
    }
    await db.query('select public.direct_entry_authz__internal_backfill_legacy_to_groups()');
    for(const u of targets)await db.query('select public.direct_entry_authz__internal_sync_legacy_grants($1::uuid)',[u.app]);
  }
  async function inCase(fn){await db.exec('begin');try{await fn();}finally{await db.exec('rollback');}}
  async function blocked(pattern,candidate=body){const before=await state();await db.exec('savepoint approved_retirement_test');await assert.rejects(()=>db.exec(candidate),e=>pattern.test(String(e.message)));await db.exec('rollback to savepoint approved_retirement_test');assert.deepEqual(await state(),before,'blocked migration must preserve both target states');assert.equal((await db.query("select count(*)::int as n from information_schema.columns where table_schema='public' and table_name='direct_entry_app_users' and column_name='account_type'")).rows[0].n,1);}
  try{
    await db.exec("create role anon;create role authenticated;create role service_role;create schema auth;create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}'::jsonb)");
    for(let i=0;i<groupIndex;i++)await db.exec(await readFile(path.join(dir,names[i]),'utf8'));
    for(const u of admins){
      await db.query('insert into auth.users(id,email) values($1::uuid,$2)',[u.auth,u.email]);
      await db.query('insert into public.direct_entry_app_users(app_user_id,auth_subject,display_name,enabled) values($1::uuid,$2::uuid,$3,true)',[u.app,u.auth,u.email]);
      await db.query("insert into public.direct_entry_scope_grants(app_user_id,scope_kind,valid_from,is_current) values($1::uuid,'all','2020-01-01',true),($1::uuid,'own','2020-01-01',true)",[u.app]);
      for(const cap of ['entry_admin','entry_team','entry_own','entry_create','submission_create','entry_privileged_edit','entry_restore','recruiter_master_manage','team_master_manage','audit_view','worker_edit_history_view','document_upload','document_view','employment_status.review','employment_status.apply','change_request_create','change_review','employment_status.request','duplicate_cccd_withdraw'])await db.query("insert into public.direct_entry_capability_grants(app_user_id,capability,valid_from,is_current) values($1::uuid,$2,'2020-01-01',true)",[u.app,cap]);
    }
    const plan=await runWp5Cutover(db,{mode:'read-only-plan'});
    assert.equal(plan.action_diff.unexpected_diff_count,0);
    await runWp5Cutover(db,{mode:'apply',confirmApply:true,expectedFingerprint:plan.manifest_fingerprint,actorAppUserId:admins[0].app,reason:'Approved Marketing retirement test setup'});
    for(let i=groupIndex;i<cleanupIndex;i++)await db.exec(await readFile(path.join(dir,names[i]),'utf8'));

    await t.test('absent UUIDs: full #237 remains applicable and ACL remains canonical',()=>inCase(async()=>{
      await db.exec(body);assert.deepEqual(await state(),[]);
      const s0=await readFile(path.join(dir,S0_T1_C_MIGRATION_NAME),'utf8');const check=await verifyS0T1CSecurityPostconditions(db,s0,new Set(names.slice(0,cleanupIndex+1)));assert.equal(check.ok,true,JSON.stringify(check));
    }));
    await t.test('fresh targets: full migration retires both, archives exact profiles and preserves identities/history',()=>inCase(async()=>{
      await seed();const old=(await db.query('select app_user_id,to_jsonb(p) as profile from public.leave_employee_profiles p where app_user_id=any($1::uuid[]) order by app_user_id',[targets.map(x=>x.app)])).rows;
      await db.exec(body);const rows=await state();assert.equal(rows.length,2);assert.ok(rows.every(r=>!r.enabled&&r.version===5&&r.profiles===0&&r.archives===1));
      const archived=(await db.query("select target_app_user_id as app_user_id,payload->'before_profile' as profile from public.leave_audit_events where event_type='EMPLOYEE_PROFILE_RETIRED' order by target_app_user_id")).rows;assert.deepEqual(archived,old);
      assert.equal((await db.query('select count(*)::int as n from auth.users where id=any($1::uuid[])',[targets.map(x=>x.auth)])).rows[0].n,2);
      assert.equal((await db.query('select count(*)::int as n from public.authz_account_role_assignments where app_user_id=any($1::uuid[]) and ended_at is not null',[targets.map(x=>x.app)])).rows[0].n,4);
      assert.equal((await db.query('select count(*)::int as n from public.direct_entry_app_user_recruiter_links where app_user_id=any($1::uuid[]) and not is_current and not suspended_by_account_disable',[targets.map(x=>x.app)])).rows[0].n,2);
    }));
    await t.test('already retired: prefix and full #237 do not duplicate audit or bump versions',()=>inCase(async()=>{await seed();await db.exec(prefix);const before=await state();await db.exec(prefix);assert.deepEqual(await state(),before);await db.exec(body);assert.deepEqual(await state(),before);}));
    await t.test('identity mismatch blocks without silently matching names',()=>inCase(async()=>{await seed();await db.query("update public.direct_entry_app_users set display_name='Changed identity' where app_user_id=$1::uuid",[targets[0].app]);await blocked(/PR28_MARKETING_RETIREMENT_STATE_CHANGED/);}));
    await t.test('disabled without retirement proof still blocks',()=>inCase(async()=>{await seed();await db.query('update public.direct_entry_app_users set enabled=false where app_user_id=$1::uuid',[targets[0].app]);await blocked(/PR28_MARKETING_RETIREMENT_INCOMPLETE/);}));
    await t.test('configured profile blocks archival',()=>inCase(async()=>{await seed();await db.query("update public.leave_employee_profiles set notes='New operational data' where app_user_id=$1::uuid",[targets[0].app]);await blocked(/PR28_MARKETING_RETIREMENT_PROFILE_CHANGED/);}));
    await t.test('leave balance activity blocks retirement',()=>inCase(async()=>{await seed();await db.query("insert into public.leave_lots(app_user_id,leave_year,lot_kind,granted_units,usable_from_date,source_ref) values($1::uuid,2026,'MANUAL_ADJUSTMENT',2,'2026-01-01','approved-retirement-fixture')",[targets[0].app]);await blocked(/PR28_MARKETING_RETIREMENT_STATE_CHANGED/);}));
    await t.test('protected target blocks retirement',()=>inCase(async()=>{
      const owner=(await db.query('select app_user_id,display_name from public.direct_entry_app_users where app_user_id=$1::uuid',[admins[0].app])).rows[0];
      // Point a test-only approved identity at the existing Owner; a second protected Owner is invalid.
      const protectedFixture=body.replace(targets[0].app,owner.app_user_id).replace("'Marketing Vĩnh Phúc'::text","'"+owner.display_name.replaceAll("'","''")+"'::text");
      await blocked(/PR28_MARKETING_RETIREMENT_STATE_CHANGED/,protectedFixture);
      assert.equal((await db.query("select count(*)::int as n from public.authz_account_role_assignments where app_user_id=$1::uuid and is_protected and ended_at is null",[owner.app_user_id])).rows[0].n,1);
    }));
    await t.test('later original cleanup gate rolls back retirement and audit atomically',()=>inCase(async()=>{
      await seed();const auth='19002370-0000-4000-8000-000000000099',app='29002370-0000-4000-8000-000000000099';
      await db.query("insert into auth.users(id,email) values($1::uuid,'unresolved@fixture.local')",[auth]);await db.query("insert into public.direct_entry_app_users(app_user_id,auth_subject,display_name,enabled,account_type) values($1::uuid,$2::uuid,'Unresolved service',false,'SERVICE')",[app,auth]);
      await blocked(/PR28_CLEANUP_BLOCKED_UNRESOLVED_LEGACY_ACCOUNT_TYPES/);
      assert.equal((await db.query("select count(*)::int as n from public.leave_audit_events where event_type='EMPLOYEE_PROFILE_RETIRED'")).rows[0].n,0);
    }));
    await t.test('unapproved UUID with approved display_name is never matched by name and stays blocked by Gate 2',()=>inCase(async()=>{
      const auth='19002370-0000-4000-8000-000000000077',app='29002370-0000-4000-8000-000000000077';
      await db.query("insert into auth.users(id,email) values($1::uuid,'impostor@fixture.local')",[auth]);
      await db.query("insert into public.direct_entry_app_users(app_user_id,auth_subject,display_name,enabled,authz_managed) values($1::uuid,$2::uuid,'Marketing Vĩnh Phúc',true,true)",[app,auth]);
      await db.query("insert into public.leave_employee_profiles(app_user_id,is_shared_non_employee,employment_status,unit_kind,updated_by_app_user_id) values($1::uuid,true,'UNCONFIGURED','UNCLASSIFIED',$2::uuid)",[app,admins[0].app]);
      await blocked(/PR28_CLEANUP_BLOCKED_UNRESOLVED_LEGACY_SHARED_PROFILES/);
      assert.equal((await db.query("select count(*)::int as n from public.leave_audit_events where event_type='EMPLOYEE_PROFILE_RETIRED'")).rows[0].n,0);
    }));
    await t.test('already retired with leftover suspended link or conflicting duplicate audit still blocks incomplete',()=>inCase(async()=>{
      await seed();await db.exec(prefix);
      await db.query('update public.direct_entry_app_user_recruiter_links set suspended_by_account_disable=true where app_user_id=$1::uuid',[targets[0].app]);
      await blocked(/PR28_MARKETING_RETIREMENT_INCOMPLETE/);
      await db.query('update public.direct_entry_app_user_recruiter_links set suspended_by_account_disable=false where app_user_id=$1::uuid',[targets[0].app]);
      await db.query("insert into public.leave_audit_events(audit_event_id,event_type,actor_app_user_id,target_app_user_id,reason,payload) values(gen_random_uuid(),'EMPLOYEE_PROFILE_RETIRED',$1::uuid,$2::uuid,'conflicting extra audit','{\"decision\":\"OTHER\"}'::jsonb)",[admins[0].app,targets[0].app]);
      await blocked(/PR28_MARKETING_RETIREMENT_INCOMPLETE/);
    }));
    await t.test('re-enabling retired target post-#237 resurrects zero recruiter links and zero grants',()=>inCase(async()=>{
      await seed();await db.exec(body);
      const ver=(await db.query('select version from public.direct_entry_app_users where app_user_id=$1::uuid',[targets[0].app])).rows[0].version;
      await db.query("select public.direct_entry_enable_app_user($1::uuid,$2::uuid,$3::uuid,$4::int,'Post-retirement re-enable check',gen_random_uuid()::text)",[admins[0].auth,admins[0].app,targets[0].app,ver]);
      assert.equal((await db.query('select count(*)::int as n from public.direct_entry_app_user_recruiter_links where app_user_id=$1::uuid and is_current',[targets[0].app])).rows[0].n,0);
      assert.equal((await db.query('select count(*)::int as n from public.direct_entry_capability_grants where app_user_id=$1::uuid and is_current',[targets[0].app])).rows[0].n,0);
      assert.equal((await db.query('select count(*)::int as n from public.direct_entry_scope_grants where app_user_id=$1::uuid and is_current',[targets[0].app])).rows[0].n,0);
      assert.deepEqual((await db.query('select public.direct_entry_authz__internal_resolve_effective_grants($1::uuid) as g',[targets[0].app])).rows[0].g,[]);
    }));
    await t.test('active Project Manager assignment blocks retirement and historical revoked PM allows',()=>inCase(async()=>{
      await seed();
      await db.query("insert into public.direct_entry_projects(project_id,display_name,active) values('PRJ_MKT_GUARD','Marketing Guard Project',true)");
      await db.query("insert into public.direct_entry_project_manager_assignments(project_id,manager_recruiter_id,valid_from,is_current,created_by_user_id) values('PRJ_MKT_GUARD',$1::uuid,'2020-01-01',true,$2::uuid)",[targets[0].recruiter,admins[0].app]);
      await blocked(/PR28_MARKETING_RETIREMENT_STATE_CHANGED/);
      await db.query("update public.direct_entry_project_manager_assignments set valid_to='2025-01-01',revoked_at=now(),is_current=false where project_id='PRJ_MKT_GUARD'");
      await db.exec(body);
      const rows=await state();
      assert.equal(rows.length,2);
      assert.ok(rows.every(r=>!r.enabled&&r.profiles===0&&r.archives===1));
    }));
    await t.test('active Work Report USER/USER_SET assignment or delegate/grantor delegation blocks, while REVOKED allows',()=>inCase(async()=>{
      await seed();
      const tplId='49002370-0000-4000-8000-000000000001',verId='49002370-0000-4000-8000-000000000002',asgUserId='49002370-0000-4000-8000-000000000003',asgSetId='49002370-0000-4000-8000-000000000004';
      await db.query("insert into public.work_report_templates(template_id,template_code,display_name,default_frequency,status,created_by_user_id) values($1::uuid,'MKT_GUARD_TPL','Guard Template','DAILY','ACTIVE',$2::uuid)",[tplId,admins[0].app]);
      await db.query("insert into public.work_report_template_versions(version_id,template_id,version_no,status,schema_json,metric_contract_json,schema_checksum,published_by_user_id,published_at) values($1::uuid,$2::uuid,1,'PUBLISHED','{}'::jsonb,'{}'::jsonb,repeat('a',64),$3::uuid,now())",[verId,tplId,admins[0].app]);
      await db.query("insert into public.work_report_assignments(assignment_id,template_id,template_version_id,target_kind,target_user_id,frequency,effective_from,state,is_current,assigned_by_user_id) values($1::uuid,$2::uuid,$3::uuid,'USER',$4::uuid,'DAILY','2026-01-01','ACTIVE',true,$5::uuid)",[asgUserId,tplId,verId,targets[0].app,admins[0].app]);
      await blocked(/PR28_MARKETING_RETIREMENT_STATE_CHANGED/);
      await db.query("update public.work_report_assignments set state='REVOKED',is_current=false where assignment_id=$1::uuid",[asgUserId]);

      await db.query("insert into public.work_report_assignments(assignment_id,template_id,template_version_id,target_kind,frequency,effective_from,state,is_current,assigned_by_user_id) values($1::uuid,$2::uuid,$3::uuid,'USER_SET','DAILY','2026-01-01','ACTIVE',true,$4::uuid)",[asgSetId,tplId,verId,admins[0].app]);
      await db.query("insert into public.work_report_assignment_targets(assignment_id,target_user_id) values($1::uuid,$2::uuid)",[asgSetId,targets[1].app]);
      await blocked(/PR28_MARKETING_RETIREMENT_STATE_CHANGED/);
      await db.query("update public.work_report_assignments set state='REVOKED',is_current=false where assignment_id=$1::uuid",[asgSetId]);

      const delDelegate=(await db.query("insert into public.work_report_delegations(grantor_user_id,delegate_app_user_id,capability,template_id,template_version_id,scope_kind,effective_from,effective_to,state,is_current) values($1::uuid,$2::uuid,'report_review',$3::uuid,$4::uuid,'all',now()-interval '1 day',now()+interval '1 day','ACTIVE',true) returning delegation_id",[admins[0].app,targets[0].app,tplId,verId])).rows[0].delegation_id;
      await blocked(/PR28_MARKETING_RETIREMENT_STATE_CHANGED/);
      await db.query("update public.work_report_delegations set state='REVOKED',is_current=false,revoked_at=now(),revoked_by_user_id=$2::uuid where delegation_id=$1::uuid",[delDelegate,admins[0].app]);

      const delGrantor=(await db.query("insert into public.work_report_delegations(grantor_user_id,delegate_app_user_id,capability,template_id,template_version_id,scope_kind,effective_from,effective_to,state,is_current) values($1::uuid,$2::uuid,'report_review',$3::uuid,$4::uuid,'all',now()-interval '1 day',now()+interval '1 day','ACTIVE',true) returning delegation_id",[targets[0].app,admins[0].app,tplId,verId])).rows[0].delegation_id;
      await blocked(/PR28_MARKETING_RETIREMENT_STATE_CHANGED/);
      await db.query("update public.work_report_delegations set state='REVOKED',is_current=false,revoked_at=now(),revoked_by_user_id=$2::uuid where delegation_id=$1::uuid",[delGrantor,admins[0].app]);

      await db.exec(body);
      const rows=await state();
      assert.equal(rows.length,2);
      assert.ok(rows.every(r=>!r.enabled&&r.profiles===0&&r.archives===1));
    }));
    await t.test('active Work Report GROUP assignment blocks and rolls back both targets, while non-member, inactive group, and REVOKED group assignment allow',()=>inCase(async()=>{
      const tplId='49002370-0000-4000-8000-000000000021',verId='49002370-0000-4000-8000-000000000022',grpId='49002370-0000-4000-8000-000000000023',asgId='49002370-0000-4000-8000-000000000024';
      await seed();
      await db.query("insert into public.work_report_templates(template_id,template_code,display_name,default_frequency,status,created_by_user_id) values($1::uuid,'MKT_GRP_TPL','Group Guard Template','DAILY','ACTIVE',$2::uuid)",[tplId,admins[0].app]);
      await db.query("insert into public.work_report_template_versions(version_id,template_id,version_no,status,schema_json,metric_contract_json,schema_checksum,published_by_user_id,published_at) values($1::uuid,$2::uuid,1,'PUBLISHED','{}'::jsonb,'{}'::jsonb,repeat('b',64),$3::uuid,now())",[verId,tplId,admins[0].app]);
      await db.query("insert into public.work_report_groups(group_id,display_name,active,created_by_user_id,updated_by_user_id) values($1::uuid,'Active WR Group',true,$2::uuid,$2::uuid)",[grpId,admins[0].app]);
      await db.query("insert into public.work_report_assignments(assignment_id,template_id,template_version_id,target_kind,target_group_id,frequency,effective_from,state,is_current,assigned_by_user_id) values($1::uuid,$2::uuid,$3::uuid,'GROUP',$4::uuid,'DAILY','2026-01-01','ACTIVE',true,$5::uuid)",[asgId,tplId,verId,grpId,admins[0].app]);

      // Positive: attach targets[1] (second in ORDER BY app_user_id) so rollback proves targets[0] is also untouched
      await db.query("insert into public.work_report_group_members(group_id,member_user_id,added_by_user_id) values($1::uuid,$2::uuid,$3::uuid)",[grpId,targets[1].app,admins[0].app]);
      await blocked(new RegExp(`PR28_MARKETING_RETIREMENT_STATE_CHANGED: ${targets[1].app}`));
      assert.equal((await db.query("select count(*)::int as n from public.leave_audit_events where event_type='EMPLOYEE_PROFILE_RETIRED'")).rows[0].n,0);

      // Control 1: non-member in active GROUP allows retirement
      await db.exec('savepoint wr_group_ctrl_nonmember');
      await db.query("delete from public.work_report_group_members where group_id=$1::uuid and member_user_id=$2::uuid",[grpId,targets[1].app]);
      await db.query("insert into public.work_report_group_members(group_id,member_user_id,added_by_user_id) values($1::uuid,$2::uuid,$2::uuid)",[grpId,admins[0].app]);
      await db.exec(body);
      const rowsCtrl1=await state();
      assert.equal(rowsCtrl1.length,2);
      assert.ok(rowsCtrl1.every(r=>!r.enabled&&r.profiles===0&&r.archives===1));
      await db.exec('rollback to savepoint wr_group_ctrl_nonmember');

      // Control 2: member of inactive work_report_groups(active=false) allows retirement
      await db.exec('savepoint wr_group_ctrl_inactive');
      await db.query("update public.work_report_groups set active=false where group_id=$1::uuid",[grpId]);
      await db.exec(body);
      const rowsCtrl2=await state();
      assert.equal(rowsCtrl2.length,2);
      assert.ok(rowsCtrl2.every(r=>!r.enabled&&r.profiles===0&&r.archives===1));
      await db.exec('rollback to savepoint wr_group_ctrl_inactive');

      // Control 3: REVOKED GROUP assignment on active group allows retirement
      await db.query("update public.work_report_assignments set state='REVOKED',is_current=false where assignment_id=$1::uuid",[asgId]);
      await db.exec(body);
      const rowsCtrl3=await state();
      assert.equal(rowsCtrl3.length,2);
      assert.ok(rowsCtrl3.every(r=>!r.enabled&&r.profiles===0&&r.archives===1));
    }));
    await t.test('audit variants: duplicate valid 2/2 and corrupt 1/0 while disabled block incomplete; pre-existing valid 1/1 while enabled blocks profile changed',async()=>{
      // Duplicate valid 2/2 while disabled -> INCOMPLETE
      await inCase(async()=>{
        await seed();await db.exec(prefix);
        const existing=(await db.query("select payload from public.leave_audit_events where target_app_user_id=$1::uuid and event_type='EMPLOYEE_PROFILE_RETIRED' limit 1",[targets[0].app])).rows[0].payload;
        await db.query("insert into public.leave_audit_events(audit_event_id,event_type,actor_app_user_id,target_app_user_id,reason,payload) values(gen_random_uuid(),'EMPLOYEE_PROFILE_RETIRED',$1::uuid,$2::uuid,'duplicate valid audit',$3::jsonb)",[admins[0].app,targets[0].app,JSON.stringify(existing)]);
        await blocked(/PR28_MARKETING_RETIREMENT_INCOMPLETE/);
      });
      // Corrupt 1/0 audit while disabled (all other postconditions clean) -> INCOMPLETE
      await inCase(async()=>{
        await seed();
        await db.query("update public.authz_user_group_members set ended_at=clock_timestamp(),ended_reason='fixture',ended_by_app_user_id=$2::uuid where app_user_id=$1::uuid and ended_at is null",[targets[0].app,admins[0].app]);
        await db.query("update public.authz_account_role_assignments set ended_at=clock_timestamp(),ended_reason='fixture',ended_by_app_user_id=$2::uuid where app_user_id=$1::uuid and ended_at is null",[targets[0].app,admins[0].app]);
        await db.query("update public.direct_entry_app_users set enabled=false,version=version+1 where app_user_id=$1::uuid",[targets[0].app]);
        await db.query("update public.direct_entry_capability_grants set is_current=false,suspended_by_account_disable=false where app_user_id=$1::uuid",[targets[0].app]);
        await db.query("update public.direct_entry_scope_grants set is_current=false,suspended_by_account_disable=false where app_user_id=$1::uuid",[targets[0].app]);
        await db.query("update public.direct_entry_app_user_recruiter_links set is_current=false,suspended_by_account_disable=false where app_user_id=$1::uuid",[targets[0].app]);
        await db.query("delete from public.leave_employee_profiles where app_user_id=$1::uuid",[targets[0].app]);
        const corruptPayload={decision:'OWNER_RETIRE_MARKETING_PR28',account_retired:true,before_profile:{app_user_id:targets[0].app,is_shared_non_employee:true,employment_status:'OFFICIAL',unit_kind:'UNCLASSIFIED',row_version:1,next_seniority_units:0,work_start_date:null,official_effective_date:null,next_seniority_effective_date:null,notes:null}};
        await db.query("insert into public.leave_audit_events(audit_event_id,event_type,actor_app_user_id,target_app_user_id,reason,payload) values(gen_random_uuid(),'EMPLOYEE_PROFILE_RETIRED',$1::uuid,$2::uuid,'corrupt audit payload',$3::jsonb)",[admins[0].app,targets[0].app,JSON.stringify(corruptPayload)]);
        await blocked(/PR28_MARKETING_RETIREMENT_INCOMPLETE/);
      });
      // Pre-existing valid 1/1 audit while enabled=true -> PROFILE_CHANGED
      await inCase(async()=>{
        await seed();
        const prof=(await db.query('select to_jsonb(p) as profile from public.leave_employee_profiles p where p.app_user_id=$1::uuid',[targets[0].app])).rows[0].profile;
        const validPayload={decision:'OWNER_RETIRE_MARKETING_PR28',account_retired:true,before_profile:prof};
        await db.query("insert into public.leave_audit_events(audit_event_id,event_type,actor_app_user_id,target_app_user_id,reason,payload) values(gen_random_uuid(),'EMPLOYEE_PROFILE_RETIRED',$1::uuid,$2::uuid,'pre-existing valid audit while enabled',$3::jsonb)",[admins[0].app,targets[0].app,JSON.stringify(validPayload)]);
        await blocked(/PR28_MARKETING_RETIREMENT_PROFILE_CHANGED/);
      });
    });
  }finally{await db.close();}
});
