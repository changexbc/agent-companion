// Codeg lifecycle comes exclusively from outbound webhooks. SQLite is used
// only for API credentials and one keyed metadata lookup after an event.
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { question, questionDetails } from './codex.js';
let DatabaseSync;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch {}
export const SOURCE = 'codeg';
export const CODEG_EVENTS = ['user_prompt_sent','question_request','permission_request','turn_complete','error'];
export function defaultCodegDbPaths(home) {
  return [path.join(home,'Library/Application Support/app.codeg/codeg.db'),path.join(home,'Library/Application Support/codeg/codeg.db'),path.join(home,'.local/share/codeg/codeg.db')];
}
export function mergeCodegWebhooks(existing, owned, url) {
  if (!Array.isArray(existing) || existing.some(w=>!w || typeof w.url!=='string' || typeof w.enabled!=='boolean')) throw Error('Codeg Webhook 配置无效，未覆盖');
  const next=existing.filter(w=>!owned.includes(w.url) && w.url!==url);
  if(url)next.push({url,enabled:true});
  return next;
}
export function askFromSnapshot(snap) {
  if(snap?.pending_question)return snap.pending_question;
  if(snap?.pending_plan_approval)return {questions:[{question:snap.pending_plan_approval.plan_markdown,options:[{label:'批准'},{label:'拒绝'}]}]};
  if(snap?.pending_permission){const p=snap.pending_permission;return {questions:[{question:p.tool_call?.title||p.tool_call?.name||'需要你的许可',options:(p.options||[]).map(o=>({label:o.name||o.label||'',description:o.kind||''}))}]};}
  return null;
}
export class CodegHooks {
  constructor(hub,{home,dbPaths=defaultCodegDbPaths(home),fetchImpl=globalThis.fetch,now=Date.now}={}) {
    Object.assign(this,{hub,home,dbPaths,fetchImpl,now});
    this.url='';this.auth=null;this.registered=false;this.nextAttempt=0;this.enabled=true;this.sequence=0;this.connections=new Map();this.ignoredConnections=new Set();
    this.stateFile=path.join(home,'.agent-studio/codeg-webhook-node.json');
  }
  open() {
    if(!DatabaseSync)throw Error('Codeg 配置需要 Node 22.13+');
    for(const p of this.dbPaths){try{return new DatabaseSync(p,{readOnly:true});}catch{}}
    throw Error('未找到 Codeg 数据库，无法读取 Web Service 配置');
  }
  credentials() {
    const db=this.open();try {
      const meta=Object.fromEntries(db.prepare("SELECT key,value FROM app_metadata WHERE key IN ('web_service_port','web_service_token')").all().map(r=>[r.key,r.value]));
      const port=Number(meta.web_service_port||3080),token=meta.web_service_token;
      if(!Number.isInteger(port)||port<1||port>65535||!token)throw Error('请启用 Codeg Web Service');
      return {port,token};
    } finally {db.close();}
  }
  async post(name,body={}) {
    const response=await this.fetchImpl(`http://127.0.0.1:${this.auth.port}/api/${name}`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${this.auth.token}`},body:JSON.stringify(body),signal:AbortSignal.timeout(1500)});
    if(!response.ok)throw Error(`Codeg API HTTP ${response.status}`);
    return response.json();
  }
  async install(base) {this.url=`${base}/api/codeg-webhook/${randomUUID()}`;this.registered=false;this.nextAttempt=0;await this.poll();}
  async poll() {
    // Only failed configuration is retried. No timer reads session state.
    if(!this.url){this.hub.health(SOURCE,'partial','Webhook 接收入口尚未启动');return;}
    if(this.registered || this.now()<this.nextAttempt)return;
    this.nextAttempt=this.now()+60000;
    try {
      let owned=[];try{owned=JSON.parse(await fs.readFile(this.stateFile,'utf8')).owned;if(!Array.isArray(owned))throw Error('invalid');}catch(e){if(e.code!=='ENOENT')throw Error('Codeg 注册记录不可读，未覆盖');}
      if(!this.enabled&&!owned.length){this.registered=true;return;}
      this.auth=this.credentials();
      const existing=await this.post('get_chat_event_webhooks');
      const next=mergeCodegWebhooks(existing,owned,this.enabled?this.url:'');
      if(this.enabled){
        const filter=await this.post('get_chat_event_filter');
        if(filter!==null && (!Array.isArray(filter)||filter.some(e=>typeof e!=='string')))throw Error('Codeg 事件配置无效，未覆盖');
        const current=filter??CODEG_EVENTS.filter(e=>e!=='user_prompt_sent');
        if(CODEG_EVENTS.some(e=>!current.includes(e))){
          // The filter is global: don't turn on new messages to other sinks.
          const channels=await this.post('list_chat_channels');
          if(!Array.isArray(channels)||channels.some(c=>c.enabled)||next.some(w=>w.url!==this.url&&w.enabled))throw Error('Codeg 全局事件开关影响其他推送目标；请先在 Codeg 启用所需的五类事件');
          await this.post('set_chat_event_filter',{filter:[...new Set([...current,...CODEG_EVENTS])]});
        }
      }
      // Journal both URLs before mutation; retry uncertain writes without duplicates.
      const url=this.enabled?this.url:'';
      if(url&&!owned.includes(url))owned.push(url);
      await fs.mkdir(path.dirname(this.stateFile),{recursive:true});
      const save=async value=>{const tmp=this.stateFile+'.tmp';await fs.writeFile(tmp,JSON.stringify(value),{mode:0o600});await fs.rename(tmp,this.stateFile);};
      await save({owned});
      if(JSON.stringify(existing)!==JSON.stringify(next))await this.post('set_chat_event_webhooks',{webhooks:next});
      await save({owned:url?[url]:[]});
      this.registered=true;
      this.hub.health(SOURCE,this.enabled?'ok':'disabled',this.enabled?'Webhook 已注册，等待 Codeg 事件（不扫描会话）':'已关闭监听');
    } catch(e) {this.hub.health(SOURCE,this.enabled?'error':'disabled',this.enabled?`Webhook 注册失败：${e.message?.startsWith('Codeg')||e.message?.startsWith('请')||e.message?.startsWith('未')?e.message:'请确认 Codeg Web Service 可用'}`:'已关闭监听；Webhook 注销待重试');}
  }
  async disable(){this.enabled=false;this.registered=false;this.nextAttempt=0;await this.poll();}
  metadata(sid) {
    const db=this.open();try{
      const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name);
      const table=tables.includes('conversation')?'conversation':'conversations';
      const row=db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(sid)||{};
      let cwd=row.origin_cwd||row.cwd||row.workspace||'';
      if(!cwd&&row.folder_id&&tables.includes('folder'))cwd=db.prepare('SELECT path FROM folder WHERE id=?').get(row.folder_id)?.path||'';
      return {title:row.title||'',cwd,agentType:row.agent_type||row.agent||'',externalId:row.external_id||'',folderId:row.folder_id,isSubagent:row.parent_id!=null||row.kind==='delegate'};
    } finally{db.close();}
  }
  async ingestHook(p) {
    if(!this.enabled||p?.source!=='codeg'||!CODEG_EVENTS.includes(p.event)||typeof p.connection_id!=='string'||!p.connection_id.trim()||p.connection_id.length>256)return false;
    if(this.ignoredConnections.has(p.connection_id))return true;
    let snap=null;
    try {this.auth??=this.credentials();snap=await this.post('acp_get_session_snapshot',{connectionId:p.connection_id});}catch{}
    const sid=String(snap?.conversation_id??this.connections.get(p.connection_id)??`connection:${p.connection_id}`);
    const provisional=`codeg:connection:${p.connection_id}`;
    if(!sid.startsWith('connection:')){this.connections.set(p.connection_id,sid);this.hub.sessions.delete(provisional);}
    if(this.connections.size>512)this.connections.delete(this.connections.keys().next().value);
    let meta={};if(!sid.startsWith('connection:'))try{meta=this.metadata(sid);}catch{}
    if(meta.isSubagent) {
      // A known child stays ignored even if later snapshot/metadata reads fail.
      this.ignoredConnections.add(p.connection_id);
      this.hub.sessions.delete(provisional);
      this.hub.sessions.delete(`codeg:${sid}`);
      return true;
    }
    const ts=this.now(),seq=++this.sequence;
    const base={source:SOURCE,sessionId:sid,ts,...meta,externalId:snap?.external_id||meta.externalId,folderId:snap?.folder_id??meta.folderId};
    const send=e=>this.hub.ingest({...base,...e});
    const current=this.hub.sessions.get(`codeg:${sid}`);
    if(p.event==='user_prompt_sent'||!current||['done','error','aborted'].includes(current.status))send({type:'start',roundId:`hook:${ts}:${seq}`,title:meta.title||String(p.body||'Codeg').slice(0,240)});
    if(p.event==='question_request'||p.event==='permission_request') {
      const ask=askFromSnapshot(snap);
      const fields=Array.isArray(p.fields)?p.fields:[];
      // Native webhook fields retain question/option text when snapshot unavailable.
      const text=ask?question(ask):fields.map(f=>String(f.value||'')).filter(Boolean).join('\n')||String(p.body||p.title||'等待确认');
      for(const pending of [...(this.hub.sessions.get(`codeg:${sid}`)?.pending||[])])send({type:'resolve',callId:pending.id});
      send({type:'wait',callId:ask?.question_id||ask?.request_id||`codeg:${p.connection_id}:${seq}`,tool:p.event==='question_request'?'ask':'permission',text,questions:ask?questionDetails(ask):[]});
    } else if(p.event==='turn_complete'||p.event==='error')send({type:'end',status:p.event==='error'?'error':'done'});
    this.hub.health(SOURCE,'ok','已收到 Codeg Webhook；回答后的状态等待下一条事件更新');
    return true;
  }
}
