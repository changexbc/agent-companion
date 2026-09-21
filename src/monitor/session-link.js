import { isDesktop, desktopCommand } from '../desktop/host.js';
export const SESSION_WINDOW = {x:14,y:18,width:484,height:232};
export const SESSION_BUTTON = {x:385,y:250,width:110,height:25,radius:6};
export const SESSION_SOURCES = ['codex','workbuddy','codebuddy-ide','codeg'];
export const AGENT_ICON_IDS = ['codex','workbuddy','codebuddy-ide','codeg','grok'];
const NESTED_AGENTS = {
  code_buddy:'codebuddy-ide', codebuddy:'codebuddy-ide', codebuddy_code:'codebuddy-ide',
  claude_code:'claude', claude_acp:'claude', claude:'claude',
  grok:'grok', grok_build:'grok',
  codex:'codex', codex_acp:'codex',
  workbuddy:'workbuddy',
};
export function sourceLabel(source, agentType) {
  if (source==='workbuddy') return agentType==='workbuddy-ai' || agentType==='international' ? 'WorkBuddy 国际版' : 'WorkBuddy';
  if (source==='codebuddy-ide') {
    const type=String(agentType||'').toLowerCase();
    if (type==='codebuddycn' || type==='domestic') return 'CodeBuddy 国内版';
    if (type==='codebuddy' || type==='international') return 'CodeBuddy 国际版';
    return 'CodeBuddy';
  }
  return source==='codex'?'Codex':source==='codeg'?'Codeg':source==='grok'?'Grok':source==='claude'?'Claude':'未绑定';
}
export function sessionSourceLabel(session) {
  return sourceLabel(session?.source, session?.agentType);
}
export function nestedAgentId(agentType) {
  const type=String(agentType||'').toLowerCase().replace(/[\s-]+/g,'_');
  if(!type)return null;
  return NESTED_AGENTS[type] || type;
}
export function sessionBadge(session) {
  if(!session?.source)return null;
  if(session.source==='codeg'){
    const nested=nestedAgentId(session.agentType);
    if(nested)return {host:'codeg',id:nested,label:sourceLabel(nested)==='未绑定'?String(session.agentType):sourceLabel(nested)};
  }
  if (session.source==='workbuddy') {
    const international = session.agentType==='workbuddy-ai' || session.agentType==='international';
    return {host:'workbuddy',id:'workbuddy',label:international?'WorkBuddy 国际版':'WorkBuddy'};
  }
  return {host:session.source,id:session.source,label:sourceLabel(session.source, session.agentType)};
}
function isCodeBuddyInternationalType(agentType) {
  const type=String(agentType||'').toLowerCase();
  if (type==='codebuddycn' || type==='domestic') return false;
  return type==='codebuddy' || type==='international' || !type;
}
export function isCodeBuddyInternational(session) {
  return session?.source==='codebuddy-ide' && isCodeBuddyInternationalType(session.agentType);
}
export function codeBuddyFolderLink(cwd, session) {
  if(typeof cwd !== 'string' || !cwd.trim())return null;
  const normalized=cwd.trim().replace(/\\/g,'/').replace(/\/+$/,'');
  if(!normalized || !/^(?:\/|[A-Za-z]:\/)/.test(normalized))return null;
  const absolute=normalized.startsWith('/')?normalized:`/${normalized}`;
  const scheme=isCodeBuddyInternationalType(session?.agentType)?'codebuddy':'codebuddycn';
  return `${scheme}://file${absolute.split('/').map(encodeURIComponent).join('/')}`;
}
export function codegAppLink(session) {
  if(session?.source!=='codeg'||typeof session?.sessionId!=='string'||!session.sessionId.trim())return null;
  if(session.sessionId.startsWith('connection:'))return '/api/open-session?source=codeg';
  return `codeg://session/${encodeURIComponent(session.sessionId.trim())}`;
}

export function isWorkBuddyInternational(session) {
  return session?.source==='workbuddy' && (session.agentType==='workbuddy-ai' || session.agentType==='international');
}

export function agentSessionLink(session) {
  if(session?.source==='codebuddy-ide'){
    const edition=isCodeBuddyInternational(session)?'international':'domestic';
    return codeBuddyFolderLink(session.cwd, session) || `/api/open-session?source=codebuddy-ide&edition=${edition}`;
  }
  if(session?.source==='codeg')return codegAppLink(session);
  if(typeof session?.sessionId !== 'string' || !session.sessionId.trim())return null;
  const id=encodeURIComponent(session.sessionId);
  if(session.source==='codex')return `codex://threads/${id}`;
  if(session.source==='workbuddy')return `${isWorkBuddyInternational(session)?'workbuddy-ai':'workbuddy'}://chat/${id}`;
  return null;
}

export function openSessionLink(url, fetchImpl=globalThis.fetch) {
  if(!url)return;
  if(isDesktop())return desktopCommand('open_session_url',{url});
  const path=url.startsWith('/')?url.split('?')[0]:(()=>{try{return new URL(url,'http://127.0.0.1').pathname;}catch{return '';}})();
  if(path==='/api/open-session'){
    if(typeof fetchImpl!=='function')return;
    return fetchImpl(url,{method:'POST'});
  }
  if(/^https?:/i.test(url)){
    const opened=typeof window.open==='function'?window.open(url,'_blank','noopener,noreferrer'):null;
    if(!opened&&typeof window.location?.assign==='function')window.location.assign(url);
    return;
  }
  if(typeof window.location!=='undefined')window.location.href=url;
}

export function workBuddySessionLink(session) {
  if (session?.source !== 'workbuddy' || typeof session.sessionId !== 'string' || !session.sessionId.trim()) return null;
  return `${isWorkBuddyInternational(session)?'workbuddy-ai':'workbuddy'}://chat/${encodeURIComponent(session.sessionId)}`;
}

// GLTF screen UVs use the same top-to-bottom orientation as our canvas texture.
export function screenSessionLink(state, uv, flippedVertical=false) {
  if(state?.mode !== 'monitor' || !uv)return null;
  const x=(uv.x*512-SESSION_WINDOW.x)*512/SESSION_WINDOW.width;
  const y=((flippedVertical ? 1-uv.y : uv.y)*288-SESSION_WINDOW.y)*288/SESSION_WINDOW.height;
  // The CTA is always available for a supported session. During a
  // question, keep the whole question card clickable as a convenient shortcut.
  const b=SESSION_BUTTON;
  const cta=x>=b.x && x<=b.x+b.width && y>=b.y && y<=b.y+b.height;
  const questionCard=state.status==='wait' && x>=109 && x<=495 && y>=100 && y<=243;
  return cta || questionCard ? agentSessionLink(state) : null;
}
