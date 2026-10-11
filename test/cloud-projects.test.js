import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,readFile,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createApp } from '../src/app.js';
import { Store } from '../src/store.js';
import { syncCloudProject } from '../src/cloud-projects.js';

const id='39cbda4f-bc0c-456a-b9dd-87a147fae3f1';
const body={schemaVersion:1,cloudProjectId:id,revision:1,slug:'example-project',code:'EXM',name:'Example',description:'',appUrl:null,status:'active'};
async function fixture(t) {
  const directory=await mkdtemp(path.join(tmpdir(),'wiki-cloud-'));
  const errors=[];
  const app=await createApp({dataDir:directory,config:{visibility:'private',publicUrl:'https://wiki.example',secureCookies:true,cognito:null},onError:error=>errors.push(error)});
  const store=app.locals.store,key=await store.issueKey('Cloud sync','projects:sync'),admin=await store.issueKey('Admin','admin');
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});assert.deepEqual(errors,[]);});
  async function put(value=body,credential=key.secret,headers={}) {
    return fetch(`http://127.0.0.1:${server.address().port}/api/v1/integrations/cloud/projects/${value.cloudProjectId}`,{method:'PUT',headers:{'Content-Type':'application/json','Idempotency-Key':`cloud-project-${value.cloudProjectId}-r${value.revision}`,...(credential?{Authorization:'Bearer '+credential}:{}),...headers},body:JSON.stringify(value)});
  }
  return {store,key,admin,put,directory,base:`http://127.0.0.1:${server.address().port}`};
}
test('dedicated credential creates once, replays after restart and preserves pages through rename/archive/restore',async t=>{
  const f=await fixture(t);
  assert.equal((await f.put()).status,201);
  const r=await f.put(Object.fromEntries(Object.entries(body).reverse()));assert.equal(r.status,200);assert.equal(r.headers.get('idempotency-replayed'),'true');
  assert.deepEqual(await r.json(),{schemaVersion:1,cloudProjectId:id,revision:1,resourceType:'project',resourceId:body.slug,url:'https://wiki.example/projects/'+body.slug});
  const page=await (await f.store.forProject(body.slug)).create('kept','# Preserve me');
  for(const [index,status] of ['active','archived','active'].entries())assert.equal((await f.put({...body,revision:index+2,name:'Renamed',status})).status,200);
  const restarted=new Store(f.directory);await restarted.init();
  const reply=await syncCloudProject(restarted,f.key.secret,{...body,revision:4,name:'Renamed'},id,`cloud-project-${id}-r4`,'https://wiki.example');assert.equal(reply.replayed,true);
  assert.equal((await (await restarted.forProject(body.slug)).get('kept')).etag,page.etag);
  await assert.rejects(restarted.deleteProject(body.slug),error=>error.code==='cloud_project');
});
test('authorization, expiry, revocation, exclusive role and private content boundaries',async t=>{
  const f=await fixture(t);assert.equal((await f.put(body,null)).status,401);assert.equal((await f.put(body,f.admin.secret)).status,403);
  assert.equal((await f.put()).status,201);
  for(const url of ['/api/pages','/api/projects','/api/keys'])assert.equal((await fetch(f.base+url,{headers:{Authorization:'Bearer '+f.key.secret}})).status,401);
  const stored=JSON.parse(await readFile(f.store.keysFile,'utf8'));const key=stored.find(k=>k.id===f.key.id);assert.notEqual(key.hash,f.key.secret);assert.ok(Date.parse(key.expiresAt)>Date.now()+89*86400000);
  key.expiresAt=new Date(0).toISOString();await writeFile(f.store.keysFile,JSON.stringify(stored));assert.equal((await f.put()).status,401);
  const fresh=await f.store.issueKey('Replacement','projects:sync');assert.equal((await f.put(body,fresh.secret)).status,200);await f.store.revokeKey(fresh.id);assert.equal((await f.put(body,fresh.secret)).status,401);
});
test('strict projection, collisions and conflicting/stale/immutable revisions fail without partial updates',async t=>{
  const f=await fixture(t);
  for(const value of [{...body,extra:true},{...body,description:null},{...body,appUrl:'http://unsafe.example'},{...body,revision:0},{...body,name:' x '}])assert.equal((await f.put(value)).status,400);
  assert.equal((await f.put(body,f.key.secret,{'Idempotency-Key':'wrong'})).status,400);
  await f.store.createProject('manual','Manual');assert.equal((await f.put({...body,slug:'manual'})).status,409);
  const results=await Promise.all([f.put(),f.put()]);assert.deepEqual(results.map(r=>r.status).sort(),[200,201]);
  assert.equal((await f.put({...body,name:'Changed'})).status,409);assert.equal((await f.put({...body,slug:'changed',revision:2})).status,409);
  assert.equal((await f.put({...body,revision:2})).status,200);assert.equal((await f.put()).status,409);
  assert.equal((await f.put({...body,cloudProjectId:'49cbda4f-bc0c-456a-b9dd-87a147fae3f1',slug:'other'})).status,409);
  assert.equal((await f.store.projects()).length,3);
});
test('throttling preserves Retry-After and no project capability is granted to browser key sessions',async t=>{
  const f=await fixture(t);
  for(let i=0;i<120;i++)assert.equal((await f.put()).status,i?200:201);
  const limited=await f.put();assert.equal(limited.status,429);assert.equal(limited.headers.get('retry-after'),'60');
  const login=await fetch(f.base+'/auth/login');const html=await login.text();const flow=login.headers.getSetCookie()[0].split(';')[0];const csrf=html.match(/name="csrf" value="([^"]+)"/)[1];
  const attempt=await fetch(f.base+'/auth/key',{method:'POST',redirect:'manual',headers:{Cookie:flow,'Content-Type':'application/x-www-form-urlencoded',Origin:'https://wiki.example'},body:new URLSearchParams({csrf,key:f.key.secret})});assert.equal(attempt.status,401);assert.ok(!attempt.headers.getSetCookie().some(c=>c.startsWith('__Host-mw_session=')));
});
