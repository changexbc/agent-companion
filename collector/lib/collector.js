import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { Hub } from './hub.js';
import { WorkBuddyPoller, defaultWorkBuddyPaths } from './workbuddy.js';
import { CodeBuddyIdePoller, defaultCodeBuddyPaths } from './codebuddy-ide.js';
import { CodexLivePoller } from './codex-live.js';
import { CodexReadStateObserver } from './codex-read-state.js';
import { CodegHooks, defaultCodegDbPaths } from './codeg.js';
import {createSettingsStore} from './settings.js';
import {SOURCE_IDS,validateSettings} from '../../src/settings-config.js';
export function createCollector({ home=os.homedir(),intervalMs=2000,monitorUrl=`http://127.0.0.1:${process.env.MONITOR_PORT||8849}`,settingsFile=path.join(home,'.agent-studio','settings.json')}={}){
 const hub=new Hub(),store=createSettingsStore(settingsFile);let initialized=false,started=false,pollers={},timer,stopped=false,chain=Promise.resolve(),codexReadState;
 const serial=fn=>{const result=chain.then(fn);chain=result.catch(()=>{});return result;};
 const resolve=p=>p.startsWith('~/')?path.join(home,p.slice(2)):p;
 function paths(id,config){const custom=config.sources[id].path;if(custom && !(id==='codebuddy-ide'&&custom.endsWith('.vscdb'))){const p=resolve(custom);if(!path.isAbsolute(p))throw Error('数据路径必须为绝对路径或以 ~/ 开头');return [p];}return id==='codex'?[path.join(home,'.codex')]:id==='workbuddy'?defaultWorkBuddyPaths(home):id==='codeg'?defaultCodegDbPaths(home):defaultCodeBuddyPaths(home);}
 function make(id,c){const p=paths(id,c)[0],custom=!!c.sources[id].path;
  if(id==='codex'){codexReadState=new CodexReadStateObserver(path.join(p,'.codex-global-state.json'));return new CodexLivePoller(hub,{home,monitorUrl,dataDir:p});}
  if(id==='workbuddy')return new WorkBuddyPoller(hub,{home,monitorUrl,dataDir:custom?p:null});
  if(id==='codeg')return new CodegHooks(hub,{home,dbPaths:custom?[p]:defaultCodegDbPaths(home)});
  return new CodeBuddyIdePoller(hub,{home,monitorUrl,dataDir:custom && !String(c.sources[id].path).endsWith('.vscdb')?p:null});
 }
 function clear(id){for(const [key,s]of hub.sessions)if(s.source===id)hub.sessions.delete(key);for(const [key,e]of hub.events)if(e.sessionId.startsWith(id+':'))hub.events.delete(key);}
 let effectiveSettings;
 async function rebuild(before,next){
  let policy={};
  try { policy=JSON.parse(await fs.readFile(path.join(home,'.agent-studio/integrations.json'),'utf8')); }
  catch(error) { if(error.code!=='ENOENT')throw error; }
  if(!policy||Array.isArray(policy)||typeof policy!=='object'||Object.entries(policy).some(([id,v])=>!SOURCE_IDS.includes(id)||typeof v!=='boolean'))throw Error('接入策略无效');
  before=effectiveSettings;
  next=structuredClone(next);
  for(const id of SOURCE_IDS)if(policy[id]===false)next.sources[id].enabled=false;
  effectiveSettings=next;
  for(const id of SOURCE_IDS){
   if(before&&JSON.stringify(before.sources[id])===JSON.stringify(next.sources[id]))continue;
   if(id==='codeg'&&pollers[id])await pollers[id].disable();
   clear(id);
   if(id!=='codeg'||next.sources[id].enabled)delete pollers[id];
   if(next.sources[id].enabled){
    pollers[id]=make(id,next);
    if(started)await pollers[id].install(monitorUrl);
   }else{
    // Keep the disabled adapter only to retry removal of our own callback.
    if(id==='codeg'&&!pollers[id]){
     pollers[id]=make(id,next);pollers[id].enabled=false;
     if(started)await pollers[id].install(monitorUrl);
    }
    hub.health(id,'disabled','已关闭监听');
   }
  }
 }
 async function ensure(){if(initialized)return;const c=await store.load();await rebuild(null,c);initialized=true;}
 async function pollNow(){await ensure();for(const id of SOURCE_IDS)if(pollers[id])await pollers[id].poll();if(pollers.codex)await codexReadState.poll(hub);hub.ready=true;}
 return {hub,poll:()=>serial(pollNow),getSettings:()=>store.value,
  setMonitorUrl(value){monitorUrl=value;},
  codegWebhookPath:()=>pollers.codeg?.url?new URL(pollers.codeg.url).pathname:null,
  ingestCodegHook:payload=>serial(async()=>{await ensure();return pollers.codeg?.ingestHook(payload);}),
  ingestCodexHook:payload=>serial(async()=>{await ensure();return pollers.codex?.ingestHook(payload);}),
  ingestCodebuddyIdeHook:payload=>serial(async()=>{await ensure();return pollers['codebuddy-ide']?.ingestHook(payload);}),
  ingestWorkbuddyHook:payload=>serial(async()=>{await ensure();return pollers.workbuddy?.ingestHook(payload);}),
  updateSettings:input=>serial(async()=>{await ensure();const next=validateSettings(input);for(const id of SOURCE_IDS)paths(id,next);const before=store.value;await store.save(next);await rebuild(before,next);await pollNow();return store.value;}),
  async checkSource({source,path:custom=''}){if(!SOURCE_IDS.includes(source)||typeof custom!=='string')throw Error('未知 Agent 来源');const config=store.value;config.sources[source].path=custom;const candidates=paths(source,config),found=[];for(const p of candidates){try{const st=await fs.stat(p);await fs.access(p,fs.constants.R_OK);if(['codex','workbuddy','codebuddy-ide'].includes(source)?!st.isDirectory():!st.isFile()&&!st.isDirectory())continue;found.push(p);}catch{}}return {ok:found.length>0,paths:found,detail:found.length?'路径可读取；会话状态以监听结果为准':'未找到可读取的数据路径，请检查路径或先运行该 Agent'};},
  async start(){await serial(async()=>{await ensure();started=true;await pollers.codeg?.install(monitorUrl);await pollers.codex?.install(monitorUrl);await pollers.workbuddy?.install(monitorUrl);await pollers['codebuddy-ide']?.install(monitorUrl);await pollNow();});const loop=async()=>{if(stopped)return;try{await serial(pollNow);}catch{}if(!stopped)timer=setTimeout(loop,intervalMs);};timer=setTimeout(loop,intervalMs);},
  async stop(){stopped=true;clearTimeout(timer);await serial(async()=>{await pollers.codeg?.disable();});}
 };
}
