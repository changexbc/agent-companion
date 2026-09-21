import { createLineCat } from './cat-motion.js';
import './welcome.css';

const NS = 'http://www.w3.org/2000/svg';
const seenKey = 'agent-studio.welcome.v1';
const eye = id => `<g id="eye-${id}"><path d="M0-4.8Q0 0 0 4.8" fill="none" stroke="#263c31" stroke-width="4.4" stroke-linecap="round"/></g>`;

function createScene(width, height) {
  const svg = document.createElementNS(NS, 'svg');
  svg.classList.add('desktop-welcome');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = `<path id="far-legs" fill="#fff" stroke="#363833" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/>
    <path id="living-line" fill="#fff" stroke="#30332f" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/>
    <g id="eyes">${eye('left')}${eye('right')}</g>`;
  return svg;
}

// One bounded animation in the existing transparent rail WebView. No extra window,
// synthetic sessions, collector traffic, timers or RAF survive completion.
export function createRailWelcome({root, rail, storage, auto = false, onInteractionChange = () => {}}) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let preferences = null, urgent = false, disposed = false, overlay, frame = 0, timer, timeout;
  let active = true, started = 0, elapsed = 0, bounds, consumed = false;
  let seen = false; try { seen = storage?.getItem(seenKey) === '1'; } catch {}
  let pending = auto && !seen && !reduced.matches;
  root.classList.toggle('welcome-blocking', pending);
  root.dataset.welcome = pending ? 'pending' : 'idle';

  function notify() { onInteractionChange(); }
  function finish(reason = 'complete') {
    clearTimeout(timer); clearTimeout(timeout); cancelAnimationFrame(frame); frame = 0;
    pending = false; overlay?.remove(); overlay = null;
    root.classList.remove('welcome-blocking', 'welcome-running');
    root.dataset.welcome = reason === 'complete' ? 'settled' : reason;
    root.dataset.welcomeTime = elapsed.toFixed(2);
    notify();
  }
  function eligible() { return !disposed && active && !document.hidden && !reduced.matches && preferences?.animation !== false && preferences !== null && !urgent; }
  function play() {
    if (!eligible()) { finish('skipped'); return false; }
    finish('preparing');
    rail.getAnimations().forEach(a => a.cancel());
    bounds = rail.getBoundingClientRect();
    // Character remains entirely inside the resident 368px window.
    const motionScale = Math.min(.55, (bounds.x - 10) / 680, (bounds.bottom - bounds.width/2 - 4) / 160);
    if (motionScale < .16 || !bounds.height) { finish('no-room'); return false; }
    overlay = createScene(innerWidth, innerHeight);
    const renderer = createLineCat(overlay, {
      rail: {x:bounds.x, y:bounds.y, width:bounds.width, height:bounds.height}, motionScale,
    });
    root.append(overlay);
    root.classList.add('welcome-running', 'welcome-blocking');
    root.dataset.welcome = 'running'; elapsed = 0; consumed = true;
    try { storage?.setItem(seenKey, '1'); } catch {}
    started = performance.now();
    renderer.render(0); notify();
    const tick = now => {
      if (!eligible()) return finish('interrupted');
      elapsed = Math.min(7, (now-started)/1000);
      try { renderer.render(elapsed); } catch { return finish('render-error'); }
      root.dataset.welcomeTime = elapsed.toFixed(2);
      if (elapsed >= 6.65 && root.classList.contains('welcome-blocking')) {
        root.classList.remove('welcome-blocking'); notify();
      }
      if (elapsed >= 7) return finish();
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    // Fail open if a suspended renderer does not reach its last frame.
    timeout = setTimeout(() => finish('timeout'), 9000);
    return true;
  }
  const layout = new ResizeObserver(() => {
    if (!overlay) return;
    const next = rail.getBoundingClientRect();
    if (Math.abs(next.height-bounds.height) > 1 || Math.abs(next.x-bounds.x) > 1 || Math.abs(next.y-bounds.y) > 1) finish('layout-change');
  });
  layout.observe(rail);
  const visibility = () => { if (document.hidden) finish('hidden'); };
  const motion = () => { if (reduced.matches) finish('reduced-motion'); };
  const resize = () => { if (overlay) finish('resize'); };
  document.addEventListener('visibilitychange', visibility);
  reduced.addEventListener('change', motion);
  window.addEventListener('resize', resize);
  // Settings failures cannot leave the actual rail hidden.
  if (pending) timeout = setTimeout(() => finish('settings-timeout'), 1800);
  return {
    get blocking() { return root.classList.contains('welcome-blocking'); },
    get running() { return Boolean(overlay); },
    play,
    setPreferences(value) {
      preferences = value;
      if (!value || !value.animation || reduced.matches) { if (pending || overlay) finish('disabled'); return; }
      if (pending && !consumed) { clearTimeout(timer); timer = setTimeout(play, 400); }
    },
    update(hasUrgentSession) { urgent = hasUrgentSession; if (urgent && (pending || overlay)) finish('urgent-session'); },
    setActive(value) { active = value; if (!active && (pending || overlay)) finish('hidden'); },
    dispose() {
      disposed = true; finish('disposed'); layout.disconnect();
      document.removeEventListener('visibilitychange', visibility);
      reduced.removeEventListener('change', motion); window.removeEventListener('resize', resize);
    },
  };
}
