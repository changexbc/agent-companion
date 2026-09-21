import {loadPreferences, watchPreferences} from './preferences.js';
import {createAvatar, avatarIdentity, updateAvatar, pointAvatar, observeAvatars} from './avatar.js';
import {automaticReminderItems,questionKey} from '../monitor/reminders.js';
import { createRailModel } from './rail-model.js';
import { sessionPresentation } from '../monitor/presentation.js';
import { openSessionLink, AGENT_ICON_IDS } from '../monitor/session-link.js';
import { createSSETransport } from '../monitor/transport.js';
import { desktopCommand, isDesktop, openDesktopView, disableNativeContentDrag, onDesktopPointer, onDesktopWindowActive } from './host.js';
import { createRailWelcome } from './welcome/index.js';
import {createIdleLamp} from './idle-lamp.js';
import './rail.css';
disableNativeContentDrag();

const el = (tag, className, text) => { const e = document.createElement(tag); if (className) e.className = className; if (text !== undefined) e.textContent = text; return e; };
const root = document.querySelector('#desktop-rail');
const avatarObserver = observeAvatars(root);
let avatarStyle = 'animal';
let storage; try { storage = localStorage; } catch {}
const model = createRailModel({ storage });
const rail = el('section', 'desktop-strip'), grip = el('div', 'desktop-grip');
grip.title = '拖动会话栏'; grip.dataset.tauriDragRegion = '';
const connection = el('span', 'desktop-connection'); connection.setAttribute('role', 'status');
const gripDots = el('span', 'desktop-grip-dots');
grip.append(connection, gripDots);
const list = el('div', 'desktop-list'); list.setAttribute('aria-label', '活跃会话');
const empty = el('div', 'desktop-empty'); empty.setAttribute('role', 'img');
const lamp = createIdleLamp(); empty.append(lamp); avatarObserver.observe(lamp);
rail.onpointerenter = e => { if (e.pointerType !== 'touch') rail.classList.add('lamp-attentive'); };
rail.onpointerleave = () => rail.classList.remove('lamp-attentive');
const menu = el('div', 'desktop-context-menu'); menu.hidden = true; menu.setAttribute('role', 'menu');
for (const [view, title] of [['settings', '悬浮窗设置']]) {
  const button = el('button', 'desktop-menu-item', title); button.type = 'button'; button.setAttribute('role', 'menuitem');
  button.onclick = () => { closeMenu(); openDesktopView(view).catch(showError); }; menu.append(button);
}
const replayWelcome = el('button', 'desktop-menu-item', '重播小猫欢迎动画');
replayWelcome.type = 'button'; replayWelcome.setAttribute('role', 'menuitem');
replayWelcome.onclick = () => { closeMenu(); welcome.play(); };
menu.append(replayWelcome);
const overflow = el('button', 'desktop-overflow'); overflow.type = 'button'; overflow.hidden = true;
overflow.onclick = () => { expanded = !expanded; hide(); render(); };
rail.append(grip, list, empty, overflow);
const card = el('section', 'desktop-card'); card.id = 'desktop-session-card'; card.hidden = true; card.setAttribute('aria-label', '会话信息');
const notice = el('p', 'desktop-notice'); notice.hidden = true; notice.setAttribute('role', 'status');
root.append(rail, card, notice, menu);
const automaticCards = new Map();
const mutedQuestions = new Map();
const buttons = new Map();
let expanded = false, visibleCount = 8;
let noticeAnchor = null;
let active = null, hideTimer, expiryTimer, noticeTimer, hitQueued = false, lastRegions = '', lastConnection;
const welcome = createRailWelcome({root, rail, storage,
  auto: isDesktop() || new URLSearchParams(location.search).has('welcome'),
  onInteractionChange: syncHitRegions,
});
const unsubscribeWindowActive = onDesktopWindowActive(value => {
  root.classList.toggle('desktop-inactive', !value);
  if (!value) rail.classList.remove('lamp-attentive');
  welcome.setActive(value);
});

function positionNotice() {
  if (notice.hidden) return;
  const surface = automaticCards.get(noticeAnchor);
  const anchor = surface && !surface.hidden ? surface : active === noticeAnchor && !card.hidden ? card : buttons.get(noticeAnchor) || rail;
  const rect = anchor.getBoundingClientRect();
  const height = notice.offsetHeight;
  let top = rect.bottom + 10;
  if (top + height > innerHeight - 8) top = rect.top - height - 10;
  notice.style.top = `${Math.max(8, Math.min(top, innerHeight - height - 8))}px`;
}
function showError(error, id = null) {
  noticeAnchor = id;
  notice.textContent = String(error?.message || error || '无法打开，请重试');
  notice.hidden = false; positionNotice(); syncHitRegions();
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { notice.hidden = true; noticeAnchor = null; syncHitRegions(); }, 5000);
}
function syncHitRegions() {
  if (!isDesktop() || hitQueued) return;
  hitQueued = true;
  queueMicrotask(() => {
    hitQueued = false;
    if (welcome.blocking) {
      if (lastRegions !== '[]') { lastRegions = '[]'; desktopCommand('set_hit_regions', {regions:[]}).catch(() => {}); }
      return;
    }
    const regions = [rail, card, notice, menu, ...automaticCards.values()].filter(e => !e.hidden).map(e => {
      const r = e.getBoundingClientRect(); return { x: r.x - 10, y: r.y - 10, width: r.width + 20, height: r.height + 20 };
    });
    const controls = [...root.querySelectorAll('button:not(:disabled), .desktop-grip')].filter(e => e.getClientRects().length && !e.closest('[hidden], .desktop-departing')).map(e => { const r = e.getBoundingClientRect(); return {x:r.x, y:r.y, width:r.width, height:r.height, cursor:e === grip ? 'grab' : 'pointer'}; });
    regions.unshift(...controls);
    const key = JSON.stringify(regions);
    if (key === lastRegions) return;
    lastRegions = key; desktopCommand('set_hit_regions', { regions }).catch(() => {});
  });
}
function reveal(surface) {
  const wasHidden = surface.hidden;
  if (!wasHidden && active !== null) surface.getAnimations().filter(a => a.effect?.getTiming().fill === 'forwards').forEach(a => a.cancel());
  surface.hidden = false;
  if (wasHidden && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    surface.animate([
      { opacity: 0, transform: 'translateX(10px) scale(.94)' },
      { opacity: 1, transform: 'translateX(-2px) scale(1.012)', offset: .75 },
      { opacity: 1, transform: 'translateX(0) scale(1)' }
    ], { duration: 260, easing: 'cubic-bezier(.22,1,.36,1)' });
  }
}
function hide() {
  clearTimeout(hideTimer); active = null;
  card.getAnimations().forEach(animation => animation.cancel());
  if (!card.hidden && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const animation = card.animate([{opacity:1, transform:'translateX(0) scale(1)'},{opacity:0, transform:'translateX(7px) scale(.97)'}], {duration:130,easing:'ease-in',fill:'forwards'});
    animation.onfinish = () => { card.hidden = true; animation.cancel(); syncHitRegions(); };
  } else card.hidden = true;
  paintAutomaticCards(); syncHitRegions();
}
function scheduleHide() { clearTimeout(hideTimer); hideTimer = setTimeout(hide, 180); }
function show(id) {
  clearTimeout(hideTimer);
  const automatic = automaticCards.get(id);
  if (automatic && !automatic.hidden) {
    // Keep the existing automatic bubble and its animation state intact.
    if (active) hide();
    return;
  }
  active = id; paintCard(); paintAutomaticCards();
}
async function open(item) {
  const p = sessionPresentation(item.session, item.offline ? 'offline' : model.connection);
  if (!p.url) return show(item.id);
  const finished = ['done', 'error', 'aborted'].includes(item.session.status);
  const roundId = item.session.roundId;
  if (finished) { model.retainOpened(item.id, roundId); render(); }
  try {
    await openSessionLink(p.url);
    if (finished) {
      model.retainOpened(item.id, roundId);
      if (active === item.id && !model.items.some(row => row.id === item.id)) hide();
      render();
    }
  } catch (error) { if (finished) { model.cancelOpened(item.id, roundId); render(); } showError(error, item.id); }
}
function providerLabel(item, p) {
  if (item.session.source === 'codeg' && p.badge?.id !== 'codeg') return `Codeg · ${p.badge?.label || p.provider}`;
  if (item.session.source === 'workbuddy' || item.session.source === 'codebuddy-ide') return p.badge?.label || p.provider;
  return p.provider;
}
function appendProviderIcons(target, item, p, hostOnly = false) {
  const info = p.badge;
  const nested = info?.host && info.host !== info.id;
  const ids = hostOnly ? [info?.host || item.session.source] : nested ? [info.host, info.id] : [info?.id || item.session.source];
  for (const id of ids) {
    if (AGENT_ICON_IDS.includes(id)) {
      const image = el('img'); image.src = `/icons/agents/${id}.png`; image.alt = '';
      image.dataset.agent = id;
      target.append(image);
    } else target.append(el('span', 'desktop-provider-fallback', (info?.label || '?').slice(0, 1).toUpperCase()));
  }
  const label = providerLabel(item, p);
  target.title = label; target.setAttribute('aria-label', label);
}
function positionPreview(surface, id) {
  const button = buttons.get(id);
  if (!button || button.hidden) { surface.hidden = true; return; }
  const b = button.getBoundingClientRect(), bounds = list.getBoundingClientRect();
  if (b.top < bounds.top || b.bottom > bounds.bottom + 1) { surface.hidden = true; return; }
  surface.style.top = `${Math.max(8, Math.min(b.top, innerHeight - surface.offsetHeight - 8))}px`;
  surface.style.setProperty('--pointer-top', `${b.top + b.height / 2 - parseFloat(surface.style.top)}px`);
}
function positionCard() {
  positionNotice();
  if (!card.hidden) positionPreview(card, active);
  for (const [id, surface] of automaticCards) if (!surface.hidden) positionPreview(surface, id);
  syncHitRegions();
}
function fillCard(surface, item, p) {
  const key = JSON.stringify([avatarStyle, item.id, item.identity, p, item.session.agentType]);
  if (surface.dataset.key === key) return;
  surface.dataset.key = key; surface.dataset.sessionId = item.id;
  const body = el('div', 'desktop-card-body');
  const head = el('div', 'desktop-card-head'), name = el('strong', '', avatarIdentity(avatarStyle, item.identity.slot).name);
  const status = el('span', 'desktop-card-status', p.statusLabel); status.dataset.status = p.status;
  const provider = el('span', 'desktop-provider');
  appendProviderIcons(provider, item, p);
  provider.append(el('span', '', p.badge?.host !== p.badge?.id ? p.badge.label : providerLabel(item, p)));
  head.append(name, status, provider);
  const preview = el('button', 'desktop-preview'); preview.type = 'button';
  const text = p.question || p.title;
  const title = el('span', 'desktop-preview-text', text); title.title = text;
  preview.append(title);
  if (p.url) {
    preview.append(el('span', 'desktop-chevron', '›')); preview.setAttribute('aria-label', `${p.action}：${text}`);
    preview.onclick = () => { const current = model.items.find(row => row.id === item.id); if (current) open(current); };
  } else preview.disabled = true;
  body.append(head, preview);
  if (['wait', 'done', 'error', 'aborted'].includes(item.session.status)) {
    const clear = el('button', 'desktop-dismiss'); clear.title = item.session.status === 'wait' ? '关闭本次待确认提示' : '收起已完成任务'; clear.setAttribute('aria-label', clear.title);
    clear.onclick = () => {
      const current = model.items.find(row => row.id === item.id);
      if (current?.session.status === 'wait') mutedQuestions.set(item.id, questionKey(current));
      else model.dismiss(item.id);
      hide(); render();
    }; body.append(clear);
  }
  surface.replaceChildren(body);
}
function paintCard() {
  const item = model.items.find(item => item.id === active); if (!item) return hide();
  const p = sessionPresentation(item.session, item.offline ? 'offline' : model.connection);
  fillCard(card, item, p);
  reveal(card); positionCard();
}
function paintAutomaticCards() {
  const items = automaticReminderItems(model.items,model.connection,mutedQuestions);
  const ids = new Set(items.map(item => item.id));
  for (const [id, surface] of automaticCards) if (!ids.has(id)) { retire(surface); automaticCards.delete(id); }
  for (const item of items) {
    let surface = automaticCards.get(item.id);
    if (!surface) {
      surface = el('section', 'desktop-card desktop-automatic-card'); surface.hidden = true; surface.setAttribute('aria-label', '任务提醒');
      root.append(surface); automaticCards.set(item.id, surface);
    }
    fillCard(surface, item, sessionPresentation(item.session, model.connection));
    if (item.id === active || !menu.hidden) surface.hidden = true;
    else { reveal(surface); positionPreview(surface, item.id); }
  }
  syncHitRegions();
}
function closeMenu() { menu.querySelectorAll('.native-hover').forEach(e => e.classList.remove('native-hover')); menu.hidden = true; paintAutomaticCards(); syncHitRegions(); }
function showMenu(event) {
  notice.hidden = true; clearTimeout(noticeTimer); noticeAnchor = null;
  event.preventDefault(); clearTimeout(hideTimer); hide(); menu.hidden = false;
  menu.style.right = '107px';
  menu.style.top = `${Math.max(8, Math.min(event.clientY || rail.offsetTop, innerHeight - menu.offsetHeight - 8))}px`;
  paintAutomaticCards(); syncHitRegions(); menu.querySelector('button').focus();
}
rail.oncontextmenu = showMenu;
root.addEventListener('contextmenu', event => {
  if (event.target.closest('.desktop-card')) showMenu(event);
});
document.addEventListener('pointerdown', event => { if (!menu.hidden && !menu.contains(event.target) && event.button !== 2) closeMenu(); });
menu.addEventListener('keydown', event => {
  const options = [...menu.querySelectorAll('button')], index = options.indexOf(document.activeElement);
  if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); options[(index + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length].focus(); }
});
function retire(element) {
  if (element.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches) { element.remove(); return; }
  const rect = element.getBoundingClientRect(), ghost = element.cloneNode(true);
  ghost.removeAttribute('id'); ghost.removeAttribute('data-session-id'); ghost.setAttribute('aria-hidden', 'true'); ghost.inert = true;
  ghost.classList.add('desktop-departing');
  Object.assign(ghost.style, {position:'absolute',left:`${rect.x}px`,top:`${rect.y}px`,right:'auto',width:`${rect.width}px`,height:`${rect.height}px`,pointerEvents:'none'});
  root.append(ghost); element.remove();
  const motion = ghost.animate([{opacity:1,transform:'scale(1)'},{opacity:0,transform:'translateX(8px) scale(.75)'}],{duration:200,easing:'ease-in',fill:'forwards'});
  motion.onfinish = () => ghost.remove();
}
function render() {
  welcome.update(model.items.some(item => ['wait', 'error'].includes(item.session.status)));
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const oldHeight = rail.getBoundingClientRect().height;
  const oldPositions = new Map([...buttons].filter(([, button]) => !button.hidden).map(([id, button]) => [id, button.getBoundingClientRect().top]));

  const items = model.items, ids = new Set(items.map(item => item.id));
  for (const [id, key] of mutedQuestions) {
    const item = items.find(row => row.id === id);
    if (!item || item.session.status !== 'wait' || questionKey(item) !== key) mutedQuestions.delete(id);
  }
  for (const [id, button] of buttons) if (!ids.has(id)) { avatarObserver.unobserve(button.querySelector('.companion-avatar')); retire(button); buttons.delete(id); }
  for (const [index, item] of items.entries()) {
    let button = buttons.get(item.id);
    if (!button) {
      button = el('button', 'desktop-avatar'); button.type = 'button'; button.dataset.sessionId = item.id; button.setAttribute('aria-controls', card.id);
      const portrait = createAvatar(avatarStyle, item.identity.slot); avatarObserver.observe(portrait);
      const source = el('span', 'desktop-source'), dot = el('i', 'desktop-dot'); button.append(portrait, source, dot);
      button.onpointerenter = e => { if (e.pointerType !== 'touch') show(item.id); }; button.onpointerleave = () => { pointAvatar(button, null); scheduleHide(); }; button.onpointermove = e => pointAvatar(button, {x:e.clientX,y:e.clientY}); button.onfocus = () => show(item.id);
      button.onclick = () => { const current = model.items.find(row => row.id === item.id); if (current) open(current); };

      buttons.set(item.id, button); list.append(button);
    }
    button.hidden = !expanded && index >= visibleCount;
    const p = sessionPresentation(item.session, item.offline ? 'offline' : model.connection), info = p.badge;
    let portrait = button.querySelector('.companion-avatar');
    if (portrait.dataset.style !== avatarStyle) { avatarObserver.unobserve(portrait); const next = createAvatar(avatarStyle, item.identity.slot); portrait.replaceWith(next); portrait = next; avatarObserver.observe(portrait); }
    updateAvatar(portrait, p.status);
    const key = JSON.stringify([avatarStyle, p.status, p.statusLabel, p.title, p.provider, info]);
    if (button.dataset.presentation !== key) {
      button.dataset.presentation = key; button.dataset.status = p.status;
      button.setAttribute('aria-label', `${avatarIdentity(avatarStyle, item.identity.slot).name} · ${providerLabel(item, p)} · ${p.statusLabel} · ${p.title}`);
      const source = button.querySelector('.desktop-source'); source.replaceChildren();
      appendProviderIcons(source, item, p, true);
    }
  }
  if (items.length <= visibleCount) expanded = false;
  overflow.hidden = items.length <= visibleCount;
  overflow.textContent = expanded ? '−' : `+${items.length - visibleCount}`;
  overflow.setAttribute('aria-expanded', String(expanded));
  overflow.setAttribute('aria-label', expanded ? '收起更多任务' : `展开其余 ${items.length - visibleCount} 个任务`);
  empty.hidden = items.length > 0; list.hidden = !items.length;
  rail.classList.toggle('desktop-strip-empty', !items.length);
  rail.dataset.connection = model.connection;
  empty.title = model.connection === 'connected' ? '正在监听，等待新任务' : model.connection === 'offline' ? '连接已中断，等待重新连接' : '正在连接监听服务';
  empty.setAttribute('aria-label', empty.title);
  connection.dataset.connection = model.connection;
  connection.title = model.connection === 'connected' ? `${items.length} 个监控会话` : model.connection === 'offline' ? '连接中断，保留最后状态' : '连接中';
  connection.setAttribute('aria-label', connection.title);
  if (active) paintCard();
  paintAutomaticCards();
  if (!reduced) {
    rail.getAnimations().forEach(animation => animation.cancel());
    const nextHeight = rail.getBoundingClientRect().height;
    if (Math.abs(nextHeight - oldHeight) > 1) {
      const motion = rail.animate([{height:`${oldHeight}px`},{height:`${nextHeight}px`}],{duration:300,easing:'cubic-bezier(.22,1,.36,1)'});
      motion.onfinish = syncHitRegions;
    }
    for (const [id, button] of buttons) {
      if (button.hidden) continue;
      const previous = oldPositions.get(id);
      if (previous === undefined) button.animate([{opacity:0,transform:'scale(.65)'},{opacity:1,transform:'scale(1)'}],{duration:280,easing:'cubic-bezier(.2,1.4,.4,1)'});
      else {
        const delta = previous - button.getBoundingClientRect().top;
        if (Math.abs(delta) > 1) button.animate([{transform:`translateY(${delta}px)`},{transform:'translateY(0)'}],{duration:300,easing:'cubic-bezier(.22,1,.36,1)'});
      }
    }
  }
  clearTimeout(expiryTimer);
  if (model.nextExpiry !== null) expiryTimer = setTimeout(() => { model.refresh(); render(); }, Math.max(1, model.nextExpiry - Date.now() + 1));
  syncHitRegions();
}
card.onpointerenter = () => clearTimeout(hideTimer); card.onpointerleave = scheduleHide;
root.addEventListener('focusout', e => { if (!root.contains(e.relatedTarget)) scheduleHide(); });
root.addEventListener('keydown', e => { if (e.key === 'Escape') { closeMenu(); const button = buttons.get(active); hide(); button?.focus(); hide(); } });
list.addEventListener('scroll', () => { if (active) paintCard(); paintAutomaticCards(); }, { passive: true });
const resize = new ResizeObserver(() => { positionCard(); syncHitRegions(); }); resize.observe(rail); resize.observe(card);
window.addEventListener('resize', positionCard);
// Unfocused macOS WebViews may not receive DOM pointerenter. Native coordinates
// share the same hover behavior without activating the app or simulating clicks.
let nativeHover = null, nativeControl = null;
const unsubscribePointer = onDesktopPointer(point => {
  const target = point ? document.elementFromPoint(point.x, point.y) : null;
  rail.classList.toggle('lamp-attentive', Boolean(target?.closest('.desktop-strip')));
  const control = target?.closest('button:not(:disabled)') || null;
  if (control !== nativeControl) { nativeControl?.classList.remove('native-hover'); control?.classList.add('native-hover'); nativeControl = control; }
  if (!menu.hidden) return;
  const avatar = target?.closest('.desktop-avatar');
  if (avatar) {
    const id = avatar.dataset.sessionId;
    if (nativeHover !== id) pointAvatar(buttons.get(nativeHover), null);
    pointAvatar(avatar, point);
    if (nativeHover !== id) { nativeHover = id; show(id); }
    else clearTimeout(hideTimer);
  } else {
    pointAvatar(buttons.get(nativeHover), null);
    nativeHover = null;
    if (target?.closest('.desktop-card')) clearTimeout(hideTimer);
    else if (active) scheduleHide();
  }
});
function applyRailSettings(settings) {
  if (!settings) return;
  const next = settings.avatarStyle === 'bot' ? 'bot' : 'animal';
  const changed = next !== avatarStyle; avatarStyle = next;
  const count = settings.visibleCount || 8;
  if (count !== visibleCount) expanded = false;
  visibleCount = count;
  root.classList.toggle('companion-motion-paused', settings.animation === false);
  if (changed) { for (const button of buttons.values()) { avatarObserver.unobserve(button.querySelector('.companion-avatar')); button.remove(); } buttons.clear(); }
  render();
  welcome.setPreferences(settings);
  replayWelcome.disabled = settings.animation === false;
}
const unsubscribeSettings = watchPreferences(applyRailSettings);
loadPreferences().then(applyRailSettings).catch(error => { welcome.setPreferences(null); showError(error); });
const unsubscribe = createSSETransport().subscribe(snapshot => { model.accept(snapshot); render(); }, value => { if (value === lastConnection) return; lastConnection = value; model.connect(value); render(); });
window.addEventListener('pagehide', () => { welcome.dispose(); unsubscribeWindowActive(); unsubscribe(); unsubscribePointer(); unsubscribeSettings(); avatarObserver.dispose(); resize.disconnect(); clearTimeout(expiryTimer); clearTimeout(hideTimer); clearTimeout(noticeTimer); }, { once: true });
render();
