import { desktopCommand, isDesktop, onRailPreferences } from './host.js';
const key = 'astra.desktop.preferences.v1';
export const defaultPreferences = () => ({ avatarStyle: 'animal', visibleCount: 8, animation: true });
export function validatePreferences(value) {
  if (!['animal', 'bot'].includes(value.avatarStyle) || !Number.isInteger(value.visibleCount) || value.visibleCount < 3 || value.visibleCount > 16 || typeof value.animation !== 'boolean') throw Error('悬浮窗设置无效');
  return { avatarStyle: value.avatarStyle, visibleCount: value.visibleCount, animation: value.animation };
}
export async function loadPreferences() {
  if (isDesktop()) return desktopCommand('rail_settings_get');
  return { ...validatePreferences(JSON.parse(localStorage.getItem(key) || 'null') || defaultPreferences()), autostart: false, autostartSupported: false };
}
export async function savePreferences(value) {
  const preferences = validatePreferences(value);
  if (isDesktop()) return desktopCommand('rail_settings_set', { preferences, autostart: value.autostart });
  localStorage.setItem(key, JSON.stringify(preferences));
  return { ...preferences, autostart: false, autostartSupported: false };
}
export function watchPreferences(callback) {
  const release = onRailPreferences(callback);
  const storage = event => { if (event.key === key) loadPreferences().then(callback).catch(() => {}); };
  window.addEventListener('storage', storage);

  return () => { release(); window.removeEventListener('storage', storage); };
}
