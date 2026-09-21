const embedHost = () => { try { return window.parent !== window ? window.parent.__AGENT_STUDIO_EMBED_HOST__ : null; } catch { return null; } };
const events = () => embedHost() ? Promise.resolve({ listen: embedHost().listen }) : import('@tauri-apps/api/event');
export const isDesktop = () => Boolean(globalThis.__TAURI_INTERNALS__ || embedHost()?.desktop);
export const isStandaloneDesktopWindow = () => Boolean(globalThis.__TAURI_INTERNALS__) && !embedHost();

export function disableNativeContentDrag(target = document) {
  target.addEventListener('dragstart', event => event.preventDefault());
}

export function installStandaloneWindowChrome() {
  disableNativeContentDrag();
  if (!isStandaloneDesktopWindow() || document.documentElement.classList.contains('tauri-desktop')) return;
  document.documentElement.classList.add('tauri-desktop');
  const drag = document.createElement('div');
  drag.className = 'window-chrome-drag';
  drag.dataset.tauriDragRegion = '';
  drag.setAttribute('aria-hidden', 'true');
  document.body.prepend(drag);
}
const api = () => embedHost() ? Promise.resolve({ invoke: embedHost().invoke }) : import('@tauri-apps/api/core');
export async function desktopCommand(command, args = {}) { return (await api()).invoke(`plugin:agent-studio|${command}`, args); }

export function onDesktopSettingsChange(callback) {
  const onLocal = event => { if (event.detail) callback(event.detail); };
  const onStorage = event => { if (event.key === 'astra.desktop.appearance.v1' && event.newValue) { try { callback(JSON.parse(event.newValue)); } catch {} } };
  window.addEventListener('agent-studio-appearance', onLocal);
  window.addEventListener('storage', onStorage);
  const cleanup = () => { window.removeEventListener('agent-studio-appearance', onLocal); window.removeEventListener('storage', onStorage); };
  if (!isDesktop()) return cleanup;
  let disposed = false, release;
  events().then(({ listen }) => listen('monitor-settings', ({ payload }) => { if (!disposed) callback(withRailPreference(payload)); }))
    .then(value => { if (disposed) value(); else release = value; }).catch(() => {});
  return () => { disposed = true; release?.(); cleanup(); };
}

export function subscribeDesktop(onSnapshot, onConnection) {
  let disposed = false, releases = [], latest = -Infinity;
  const deliver = snapshot => { if (snapshot.ts < latest) return; latest = snapshot.ts; onSnapshot(snapshot); };
  onConnection('connecting');
  (async () => {
    const { listen } = await events();
    const keep = release => { if (disposed) release(); else releases.push(release); };
    keep(await listen('monitor-state', ({ payload }) => { if (!disposed) { deliver(payload); onConnection(payload.ready ? 'connected' : 'connecting'); } }));
    keep(await listen('monitor-connection', ({ payload }) => { if (!disposed) onConnection(payload); }));
    const initial = await desktopCommand('monitor_state');
    if (!disposed) {
      if (initial.snapshot) deliver(initial.snapshot);
      onConnection(initial.connected ? 'connected' : 'offline');
    }
  })().catch(() => { if (!disposed) onConnection('offline'); });
  return () => { disposed = true; releases.forEach(release => release()); releases = []; };
}

const railPreferenceKey = 'astra.desktop.visible-count.v1';
function withRailPreference(value) {
  try {
    const count = Number(localStorage.getItem(railPreferenceKey));
    if (value?.monitor && Number.isInteger(count) && count >= 3 && count <= 16) value.monitor.railVisibleCount = count;
  } catch {}
  return value;
}
function publishAppearance(value) {
  // Publish only confirmed saves; the backend remains the source of truth.
  try { localStorage.setItem('astra.desktop.appearance.v1', JSON.stringify(value)); } catch {}
  window.dispatchEvent(new CustomEvent('agent-studio-appearance', {detail:value}));
}
export async function hostFetch(url, options = {}) {
  if (!isDesktop()) {
    const response = await fetch(url, options);
    if (url === '/api/settings' && options.method === 'PUT' && response.ok) publishAppearance(await response.clone().json());
    return response;
  }
  let command;
  if (url === '/api/settings') command = options.method === 'PUT' ? 'settings_set' : 'settings_get';
  else if (url === '/api/settings/check') command = 'settings_check';
  else throw new Error('Unsupported desktop request');
  try {
    const value = await desktopCommand('collector_request', { command, payload: options.body ? JSON.parse(options.body) : null });
    if (command === 'settings_set') {
      publishAppearance(value);
      const count = JSON.parse(options.body || '{}').monitor?.railVisibleCount;
      if (Number.isInteger(count) && count >= 3 && count <= 16) {
        try { localStorage.setItem(railPreferenceKey, String(count)); } catch {}
        window.dispatchEvent(new CustomEvent('agent-studio-rail-preference', {detail:count}));
      }
    }
    return { ok: true, json: async () => url === '/api/settings' ? withRailPreference(value) : value };
  } catch (error) { return { ok: false, json: async () => ({ error: String(error) }) }; }
}

export async function enableNotifications() {
  if (embedHost()) return embedHost().enableNotifications();
  if (isDesktop()) {
    const { isPermissionGranted, requestPermission } = await import('@tauri-apps/plugin-notification');
    return await isPermissionGranted() ? 'granted' : requestPermission();
  }
  return globalThis.Notification ? Notification.requestPermission() : 'unsupported';
}

export async function openDesktopView(view) {
  if (!['rail', 'settings'].includes(view)) throw new Error('未知视图');
  if (isDesktop()) return desktopCommand('open_view', { view });
  window.open(view === 'rail' ? '/desktop.html' : '/desktop-settings.html', '_blank', 'noopener,noreferrer');
}

// Event-driven native hover, including while another app owns keyboard focus.
export function onDesktopPointer(callback) {
  if (!isDesktop()) return () => {};
  let disposed = false, release;
  events().then(({ listen }) => listen('agent-studio-pointer', ({ payload }) => {
    if (!disposed) callback(payload);
  })).then(value => { if (disposed) value(); else release = value; }).catch(() => {});
  return () => { disposed = true; release?.(); };
}

export function onDesktopWindowActive(callback) {
  if (!isDesktop()) return () => {};
  let disposed = false, release;
  events().then(({listen}) => listen('agent-studio-window-active', ({payload}) => {
    if (!disposed && typeof payload?.active === 'boolean') callback(payload.active);
  })).then(fn => { if (disposed) fn(); else release = fn; }).catch(() => {});
  return () => { disposed = true; release?.(); };
}

export function onRailPreferences(callback) {
  if (!isDesktop()) return () => {};
  let disposed = false, release;
  events().then(({ listen }) => listen('agent-studio-rail-settings', ({ payload }) => { if (!disposed) callback(payload); }))
    .then(fn => { if (disposed) fn(); else release = fn; }).catch(() => {});
  return () => { disposed = true; release?.(); };
}
