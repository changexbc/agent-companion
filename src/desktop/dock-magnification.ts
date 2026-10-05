import { reducedMotion } from './rail-animations.js';

export interface DockPoint { x: number; y: number }

/** A smooth, local lens: the nearest portrait grows most; distant rows stay put. */
export function dockScale(distance: number, diameter: number) {
  if (!Number.isFinite(distance) || !Number.isFinite(diameter) || diameter <= 0) return 1;
  const fraction = Math.min(1, Math.abs(distance) / (diameter * 2.1));
  return 1 + .2 * (1 + Math.cos(Math.PI * fraction));
}

export function createDockMagnification(options: {
  list: () => HTMLElement | null;
  avatars: () => Iterable<HTMLElement>;
  enabled: () => boolean;
  onGeometryChange: () => void;
}) {
  let point: DockPoint | null = null;
  let frame = 0;
  let previousTime = 0;
  let dragging = false;
  const scales = new Map<HTMLElement, number>();
  const media = matchMedia('(prefers-reduced-motion: reduce)');

  function tick(time: number) {
    frame = 0;
    const enabled = options.enabled() && !reducedMotion() && !dragging;
    const list = options.list();
    const bounds = list?.getBoundingClientRect();
    const near = enabled && point && bounds && point.x >= bounds.left - 4 && point.x <= bounds.right + 4
      && point.y >= bounds.top - 12 && point.y <= bounds.bottom + 12 ? point : null;
    const blend = 1 - Math.exp(-Math.min(32, previousTime ? time - previousTime : 16) / 50);
    previousTime = time;
    let moving = false;
    const alive = new Set<HTMLElement>();
    for (const element of options.avatars()) {
      alive.add(element);
      let target = 1;
      if (near && bounds && list && !element.hidden && element.offsetHeight > 0) {
        // Layout coordinates never include our scale or arrival/reorder animations.
        // Reading transformed centers here would feed the lens back into itself.
        const height = element.offsetHeight;
        const top = bounds.top + element.offsetTop - (element.offsetParent === list ? 0 : list.offsetTop) - list.scrollTop;
        const x = bounds.left + bounds.width / 2;
        const y = top + height / 2;
        if (top >= bounds.top && top + height <= bounds.bottom) {
          const room = Math.min((y - bounds.top) * 2 / height, (bounds.bottom - y) * 2 / height,
            bounds.width / element.offsetWidth, (innerHeight - y) * 2 / height, y * 2 / height);
          target = Math.min(dockScale(Math.hypot(near.x - x, near.y - y), height), Math.max(1, room));
        }
      }
      const current = scales.get(element) ?? 1;
      const next = !enabled || Math.abs(target - current) < .001 ? target : current + (target - current) * blend;
      const rounded = Number(next.toFixed(4));
      if (rounded !== current) element.style.setProperty('--dock-scale', String(rounded));
      scales.set(element, rounded);
      if (Math.abs(target - rounded) >= .001) moving = true;
    }
    for (const element of scales.keys()) if (!alive.has(element)) {
      element.style.removeProperty('--dock-scale');
      scales.delete(element);
    }
    options.onGeometryChange();
    if (moving) frame = requestAnimationFrame(tick);
    else previousTime = 0;
  }

  function refresh() { if (!frame) frame = requestAnimationFrame(tick); }
  function update(next: DockPoint | null) { point = next; refresh(); }
  const ignored = (target: EventTarget | null) => target instanceof Element
    && !!target.closest('.desktop-grip,.desktop-card,.desktop-overflow,.desktop-context-menu');
  const move = (event: PointerEvent) => update(event.pointerType === 'touch' || event.buttons || ignored(event.target)
    ? null : {x: event.clientX, y: event.clientY});
  const leave = () => { dragging = false; update(null); };
  const down = () => { dragging = true; update(null); };
  const up = (event: PointerEvent) => { dragging = false; move(event); };
  document.addEventListener('pointermove', move);
  document.documentElement.addEventListener('pointerleave', leave);
  document.addEventListener('pointerdown', down, true);
  document.addEventListener('pointerup', up, true);
  window.addEventListener('blur', leave);
  document.addEventListener('visibilitychange', leave);
  media.addEventListener('change', refresh);

  return {
    update, refresh,
    dispose() {
      cancelAnimationFrame(frame);
      document.removeEventListener('pointermove', move);
      document.documentElement.removeEventListener('pointerleave', leave);
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('pointerup', up, true);
      window.removeEventListener('blur', leave);
      document.removeEventListener('visibilitychange', leave);
      media.removeEventListener('change', refresh);
      for (const element of scales.keys()) element.style.removeProperty('--dock-scale');
      scales.clear();
    },
  };
}
