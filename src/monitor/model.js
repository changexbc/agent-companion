export const STATUS = { running: '运行中', wait: '待确认', done: '已完成', error: '失败', aborted: '已中止', unknown: '状态未知', idle: '空闲', offline: '已断连' };
export function sessionHeadline(session, status='idle') {
  const title=String(session?.title||'').trim();
  if(title)return title;
  const project=String(session?.project||'').trim();
  if(project && project!==session?.source)return project;
  return STATUS[status]||'空闲';
}
export const ACTIVE = new Set(['running','wait']);
export const COMPLETION_HOLD_MS = 30 * 60_000;
const TERMINAL = new Set(['done','error','aborted']);
export function assignSessions(previous, sessions, now = Date.now(), count = 8, preferredSeats = new Map(), dismissed = new Set(), options = {}) {
  const allowed=(session,i)=>options.assignment!=='fixed'||!options.seats?.[i]||options.seats[i]==='auto'||options.seats[i]===session.source;
  const byId = new Map(sessions.map(s=>[s.id,s]));
  const slots = Array.from({length:count},(_,i)=>previous[i] || null);
  const candidates = sessions.filter(s=>ACTIVE.has(s.status)&&(options.autoDiscover!==false||previous.includes(s.id))).sort((a,b)=>Number(b.status==='wait')-Number(a.status==='wait')||b.updatedAt-a.updatedAt||a.id.localeCompare(b.id));
  for(let i=0;i<count;i++) {
    const current=byId.get(slots[i]);
    if(!current||!allowed(current,i))slots[i]=null;
    else if(current.status==='idle')slots[i]=null;
    else if(dismissed.has(current.id) && TERMINAL.has(current.status))slots[i]=null;
    else if(TERMINAL.has(current.status) && now-(current.endedAt??current.updatedAt)>=(options.retentionHours??.5)*3600000)slots[i]=null;
  }
  const available=candidates.filter(s=>!slots.includes(s.id));
  // Only release a completed seat early when all empty seats will be needed.
  let needed=available.length-slots.filter(id=>!id).length;
  for(let i=0;i<count && needed>0;i++)if(TERMINAL.has(byId.get(slots[i])?.status)){slots[i]=null;needed--;}
  // Reuse a returning conversation's former resident if that resident is free.
  for(const session of available.slice(0,slots.filter(id=>!id).length)){const seat=preferredSeats.get(session.id);if(Number.isInteger(seat)&&seat>=0&&seat<count&&!slots[seat]&&allowed(session,seat))slots[seat]=session.id;}
  const remaining=available.filter(s=>!slots.includes(s.id));
  for(let i=0;i<count;i++)if(!slots[i]){const index=remaining.findIndex(s=>allowed(s,i));if(index>=0)slots[i]=remaining.splice(index,1)[0].id;}
  return slots;
}
export function createNotificationTracker({ storage, now = Date.now } = {}) {
  const key='astra.monitor.notifications.v1'; let saved;
  try { saved=JSON.parse(storage?.getItem(key)||'null'); } catch {}
  const seen = new Set(Array.isArray(saved?.seen)?saved.seen:[]);
  const alerts = Array.isArray(saved?.alerts)?saved.alerts.slice(0,60):[];
  let initialized=false,lastSaved=JSON.stringify({seen:[...seen].slice(-2000),alerts});
  return { alerts, ingest(snapshot) {
    if(!snapshot.ready)return [];
    const byId=new Map(snapshot.sessions.map(s=>[s.id,s])); const fresh=[];
    for(const event of snapshot.events) {
      if(seen.has(event.id))continue;
      seen.add(event.id);
      const session=byId.get(event.sessionId);
      const unresolved=event.kind==='wait' && session?.roundId===event.roundId && session.pending.some(p=>JSON.parse(event.id)[3]===p.id);
      if(event.kind==='wait' ? !unresolved : !initialized || event.historical)continue;
      const alert={...event, title:session?.title||event.title, receivedAt:now()}; fresh.push(alert); alerts.unshift(alert);
    }
    initialized=true;alerts.splice(60);
    while(seen.size>2000)seen.delete(seen.values().next().value);
    const serialized=JSON.stringify({seen:[...seen],alerts});
    if(serialized!==lastSaved)try { storage?.setItem(key,serialized);lastSaved=serialized; } catch {}
    return fresh;
  } };
}
