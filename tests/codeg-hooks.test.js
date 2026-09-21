import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { CodegHooks, CODEG_EVENTS, mergeCodegWebhooks } from '../collector/lib/codeg.js';
import { Hub } from '../collector/lib/hub.js';
import { createCollector } from '../collector/lib/collector.js';
import { startServer } from '../collector/server.js';
import { defaultSettings } from '../src/settings-config.js';
import { codegAppLink } from '../src/monitor/session-link.js';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<100;i++){const result=await fn();if(result)return result;await wait(50);}throw Error('condition timed out');}
async function fixture(t) {
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'codeg-hooks-'));
 t.after(()=>fs.rm(home,{recursive:true,force:true}));
 const state={hooks:[],filter:null,channels:[],calls:[],snapshot:{conversation_id:214,external_id:'thr-native',folder_id:1},fail:false};
 const server=http.createServer(async(req,res)=>{
  const parts=[];for await(const chunk of req)parts.push(chunk);
  const body=JSON.parse(Buffer.concat(parts).toString()||'{}'),method=req.url.slice(5);
  assert.equal(req.headers.authorization,'Bearer secret-test-token');
  state.calls.push({method,body});
  if(state.fail){res.writeHead(503).end();return;}
  let result=null;
  if(method==='get_chat_event_webhooks')result=state.hooks;
  else if(method==='set_chat_event_webhooks'){
   state.hooks=body.webhooks;
   if(state.dropSetResponse){state.dropSetResponse=false;res.destroy();return;}
  }
  else if(method==='get_chat_event_filter')result=state.filter;
  else if(method==='set_chat_event_filter')state.filter=body.filter;
  else if(method==='list_chat_channels')result=state.channels;
  else if(method==='acp_get_session_snapshot')result=state.snapshot;
  else throw Error(`Unexpected API (no scanning allowed): ${method}`);
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>new Promise(r=>server.close(r)));
 const dir=path.join(home,'Library/Application Support/app.codeg');await fs.mkdir(dir,{recursive:true});
 const dbPath=path.join(dir,'codeg.db'),db=new DatabaseSync(dbPath);
 db.exec('CREATE TABLE app_metadata(key TEXT,value TEXT); CREATE TABLE conversation(id INTEGER,title TEXT,agent_type TEXT,external_id TEXT,folder_id INTEGER,status TEXT); CREATE TABLE folder(id INTEGER,path TEXT);');
 db.prepare('INSERT INTO app_metadata VALUES (?,?)').run('web_service_port',String(server.address().port));
 db.prepare('INSERT INTO app_metadata VALUES (?,?)').run('web_service_token','secret-test-token');
 db.exec("INSERT INTO conversation VALUES(214,'Build feature','codex','thr-native',1,'in_progress'); INSERT INTO folder VALUES(1,'/project/test');");db.close();
 const settings=defaultSettings();for(const [id,s]of Object.entries(settings.sources))s.enabled=id==='codeg';
 await fs.mkdir(path.join(home,'.agent-studio'),{recursive:true});await fs.writeFile(path.join(home,'.agent-studio/settings.json'),JSON.stringify(settings));
 return {home,dbPath,state,settings};
}
function addChild(dbPath,{parent=214,kind='delegate'}={}) {
 const db=new DatabaseSync(dbPath);
 try {
  db.exec("ALTER TABLE conversation ADD COLUMN parent_id INTEGER; ALTER TABLE conversation ADD COLUMN kind TEXT DEFAULT 'regular';");
  db.prepare('INSERT INTO conversation(id,title,agent_type,external_id,folder_id,status,parent_id,kind) VALUES(?,?,?,?,?,?,?,?)').run(215,'Child task','codex','thr-child',1,'in_progress',parent,kind);
 } finally {db.close();}
}
const event=(name,extra={})=>({source:'codeg',connection_id:'connection-1',event:name,body:'Task',...extra});

test('merge preserves third-party hooks, rejects malformed config, replaces only owned addresses',()=>{
 const other={url:'https://example.test/other',enabled:false};
 assert.deepEqual(mergeCodegWebhooks([other,{url:'http://old',enabled:true}],['http://old'],'http://new'),[other,{url:'http://new',enabled:true}]);
 assert.throws(()=>mergeCodegWebhooks({},[],'x'));
 assert.throws(()=>mergeCodegWebhooks([{url:'x'}],[],'x'));
});

test('registration is idempotent, no session polling, actual HTTP delivery and disable',async t=>{
 const f=await fixture(t);f.state.hooks=[{url:'https://example.test/unrelated',enabled:false}];
 const collector=createCollector({home:f.home,intervalMs:20});const runtime=await startServer({port:0,collector});t.after(()=>runtime.close());
 const target=f.state.hooks.find(w=>w.url.startsWith('http://127.0.0.1')).url;
 assert.deepEqual(f.state.filter,CODEG_EVENTS.slice(1).concat('user_prompt_sent'));
 assert.equal(collector.hub.sessions.size,0,'existing SQLite rows never create sessions');
 const count=f.state.calls.length;await wait(150);assert.equal(f.state.calls.length,count,'idle timer never calls Codeg');
 const deliver=async p=>assert.equal((await fetch(target,{method:'POST',body:JSON.stringify(p)})).status,204);
 await deliver(event('user_prompt_sent'));
 assert.equal(collector.hub.sessions.get('codeg:214').status,'running');
 assert.equal(collector.hub.sessions.get('codeg:214').cwd,'/project/test');
 assert.equal(codegAppLink(collector.hub.sessions.get('codeg:214')),'codeg://session/214');
 f.state.snapshot.pending_question={question_id:'q1',questions:[{question:'Pick',options:[{label:'A'},{label:'B'}]}]};
 await deliver(event('question_request'));let session=collector.hub.sessions.get('codeg:214');assert.equal(session.status,'wait');assert.equal(session.pending[0].questions[0].options[1].label,'B');
 f.state.snapshot.pending_question=null;await wait(80);assert.equal(collector.hub.sessions.get('codeg:214').status,'wait','answer cannot be inferred without an event');
 await deliver(event('turn_complete'));assert.equal(collector.hub.sessions.get('codeg:214').status,'done');
 await deliver(event('user_prompt_sent'));assert.equal(collector.hub.sessions.get('codeg:214').status,'running');
 await deliver(event('error'));assert.equal(collector.hub.sessions.get('codeg:214').status,'error');
 assert.equal((await fetch(target,{method:'POST',headers:{Origin:'https://evil.test'},body:'{}'})).status,403);
 assert.equal((await fetch(target,{method:'POST',body:'x'.repeat(65537)})).status,413);
 assert.equal((await fetch(target.replace(/[^/]+$/,'wrong'),{method:'POST',body:'{}'})).status,405);
 f.settings.sources.codeg.enabled=false;await collector.updateSettings(f.settings);
 assert.equal(collector.hub.sessions.size,0);assert.deepEqual(f.state.hooks,[{url:'https://example.test/unrelated',enabled:false}]);
 assert.equal((await fetch(target,{method:'POST',body:JSON.stringify(event('user_prompt_sent'))})).status,410);assert.equal(collector.hub.sessions.size,0);
});

test('restart replaces the old owned URL and preserves enabled unrelated webhook',async t=>{
 const f=await fixture(t);f.state.filter=[...CODEG_EVENTS,'future_event'];f.state.hooks=[{url:'https://example.test/other',enabled:true}];
 const first=new CodegHooks(new Hub(),f);await first.install('http://127.0.0.1:8801');const old=first.url;
 const second=new CodegHooks(new Hub(),f);await second.install('http://127.0.0.1:8802');
 assert.equal(f.state.hooks.length,2);assert.ok(!f.state.hooks.some(w=>w.url===old));assert.ok(f.state.filter.includes('future_event'));
 const count=f.state.calls.length;await second.poll();assert.equal(f.state.calls.length,count);
 await second.disable();assert.equal(f.state.hooks.length,1);
});

test('global opt-in never starts additional deliveries to other enabled sinks',async t=>{
 const f=await fixture(t);f.state.channels=[{enabled:true}];const hub=new Hub(),hooks=new CodegHooks(hub,f);await hooks.install('http://127.0.0.1:8849');
 assert.equal(hooks.registered,false);assert.equal(f.state.filter,null);assert.equal(f.state.hooks.length,0);
 assert.match(hub.snapshot().sources.codeg.detail,/其他推送/);
});

test('failed configuration retries are bounded and can recover',async t=>{
 const f=await fixture(t);let now=0;f.state.fail=true;
 const h=new CodegHooks(new Hub(),{...f,now:()=>now});await h.install('http://127.0.0.1:8849');const n=f.state.calls.length;
 for(let i=0;i<10;i++)await h.poll();assert.equal(f.state.calls.length,n);
 now=60001;f.state.fail=false;await h.poll();assert.equal(h.registered,true);
 await h.disable();
});

test('lost write response and restart retain ownership, then a disabled startup removes it',async t=>{
 const f=await fixture(t);f.state.filter=[...CODEG_EVENTS];
 const first=new CodegHooks(new Hub(),f);await first.install('http://127.0.0.1:8801');
 f.state.dropSetResponse=true;
 const second=new CodegHooks(new Hub(),f);await second.install('http://127.0.0.1:8802');
 assert.equal(second.registered,false);assert.equal(f.state.hooks.length,1);assert.equal(f.state.hooks[0].url,second.url);
 const third=new CodegHooks(new Hub(),f);await third.install('http://127.0.0.1:8803');
 assert.equal(third.registered,true);assert.deepEqual(f.state.hooks,[{url:third.url,enabled:true}]);
 f.settings.sources.codeg.enabled=false;
 await fs.writeFile(path.join(f.home,'.agent-studio/settings.json'),JSON.stringify(f.settings));
 const runtime=await startServer({port:0,collector:createCollector({home:f.home})});t.after(()=>runtime.close());
 assert.deepEqual(f.state.hooks,[]);
});

test('missing snapshot retains webhook text and cannot invent a conversation deep link',async t=>{
 const f=await fixture(t);f.state.snapshot=null;const hub=new Hub(),h=new CodegHooks(hub,f);
 await h.ingestHook(event('permission_request',{fields:[{label:'Operation',value:'Allow shell?'}]}));
 let s=hub.sessions.get('codeg:connection:connection-1');assert.equal(s.status,'wait');assert.equal(s.pending[0].text,'Allow shell?');assert.equal(codegAppLink(s),'/api/open-session?source=codeg');
 assert.equal(await h.ingestHook(event('unsupported')),false);
 f.state.snapshot={conversation_id:214};await h.ingestHook(event('turn_complete'));assert.equal(hub.sessions.size,1);assert.equal(hub.sessions.get('codeg:214').status,'done');
});

for(const marker of [{parent:214,kind:'delegate'},{parent:214,kind:'regular'},{parent:null,kind:'delegate'}]) {
 test(`child events are ignored using metadata ${JSON.stringify(marker)}`,async t=>{
  const f=await fixture(t);addChild(f.dbPath,marker);
  const hub=new Hub(),h=new CodegHooks(hub,f);
  await h.ingestHook(event('user_prompt_sent'));
  const parent=structuredClone(hub.sessions.get('codeg:214'));
  f.state.snapshot=null;
  await h.ingestHook(event('user_prompt_sent',{connection_id:'child'}));
  assert.ok(hub.sessions.has('codeg:connection:child'));
  f.state.snapshot={conversation_id:215};
  for(const name of CODEG_EVENTS)assert.equal(await h.ingestHook(event(name,{connection_id:'child'})),true);
  assert.equal(hub.sessions.size,1);
  assert.deepEqual(hub.sessions.get('codeg:214'),parent,'child never changes parent state');
  const calls=f.state.calls.length;f.state.fail=true;
  await h.ingestHook(event('permission_request',{connection_id:'child'}));
  assert.equal(f.state.calls.length,calls,'known child does not query API again');
  assert.equal(hub.sessions.size,1,'API failure never resurrects a known child');
  f.state.fail=false;f.state.snapshot={conversation_id:214};
  await h.ingestHook(event('turn_complete'));
  assert.equal(hub.sessions.get('codeg:214').status,'done');
 });
}

// Exercise the shipped native HTTP receiver against the same fake Codeg API.
// Run after cargo build -p agent-studio-runtime with CODEG_RUNTIME_BINARY set.
test('native runtime registers, receives callbacks, rejects forged requests and unregisters', {skip:!process.env.CODEG_RUNTIME_BINARY},async t=>{
 const f=await fixture(t);f.state.hooks=[{url:'https://example.test/keep',enabled:false}];
 const child=spawn(process.env.CODEG_RUNTIME_BINARY,['serve','--home',f.home],{stdio:['ignore','ignore','pipe']});let stderr='';child.stderr.on('data',b=>stderr+=b);
 t.after(()=>child.kill());
 const endpoint=await until(async()=>{try{return JSON.parse(await fs.readFile(path.join(f.home,'.agent-studio/runtime-v1.json'),'utf8'));}catch{return null;}});
 const rpc=async(command,payload={})=>{const r=await fetch(`http://127.0.0.1:${endpoint.port}/rpc`,{method:'POST',headers:{Authorization:`Bearer ${endpoint.token}`},body:JSON.stringify({command,payload})});return r.json();};
 await rpc('hello',{client:'test'});
 const target=await until(()=>f.state.hooks.find(w=>w.url.startsWith('http://127.0.0.1'))?.url);
 const snapshot=async()=> (await rpc('poll',{client:'test'})).value.snapshot;
 assert.equal((await snapshot()).sessions.length,0,stderr);
 const n=f.state.calls.length;await wait(2200);assert.equal(f.state.calls.length,n);
 assert.equal((await fetch(target,{method:'POST',body:JSON.stringify(event('user_prompt_sent'))})).status,204);
 const s=await until(async()=> (await snapshot()).sessions.find(s=>s.id==='codeg:214'));
 assert.equal(s.status,'running');assert.equal(s.cwd,'/project/test');
 addChild(f.dbPath);
 f.state.snapshot=null;
 await fetch(target,{method:'POST',body:JSON.stringify(event('user_prompt_sent',{connection_id:'child'}))});
 await until(async()=> (await snapshot()).sessions.some(s=>s.id==='codeg:connection:child'));
 f.state.snapshot={conversation_id:215};
 for(const name of CODEG_EVENTS) {
  assert.equal((await fetch(target,{method:'POST',body:JSON.stringify(event(name,{connection_id:'child'}))})).status,204);
  await until(async()=> (await snapshot()).sessions.length===1);
 }
 f.state.fail=true;
 await fetch(target,{method:'POST',body:JSON.stringify(event('permission_request',{connection_id:'child'}))});
 const afterChild=await snapshot();
 assert.equal(afterChild.sessions.length,1);assert.equal(afterChild.sessions[0].status,'running');
 f.state.fail=false;f.state.snapshot={conversation_id:214};
 f.state.snapshot.pending_question={question_id:'q1',questions:[{question:'Pick',options:[{label:'A'}]}]};
 await fetch(target,{method:'POST',body:JSON.stringify(event('question_request'))});
 await until(async()=> (await snapshot()).sessions.some(s=>s.status==='wait'));
 await fetch(target,{method:'POST',body:JSON.stringify(event('turn_complete'))});
 await until(async()=> (await snapshot()).sessions.some(s=>s.status==='done'));
 assert.equal((await fetch(target.replace(/[^/]+$/,'wrong'),{method:'POST',body:'{}'})).status,403);
 assert.equal((await fetch(target,{method:'POST',headers:{Origin:'http://evil.test'},body:'{}'})).status,403);
 assert.equal((await fetch(target,{method:'POST',body:'x'.repeat(65537)})).status,413);
 f.settings.sources.codeg.enabled=false;assert.ok((await rpc('settings_set',f.settings)).value);
 await until(()=>f.state.hooks.length===1);
 assert.equal((await fetch(target,{method:'POST',body:JSON.stringify(event('user_prompt_sent'))})).status,410);
 assert.equal((await snapshot()).sessions.length,0);
});
