import { hostFetch } from './host.js';
export const agents = [['codex', 'Codex'], ['workbuddy', 'WorkBuddy'], ['codebuddy-ide', 'CodeBuddy'], ['codeg', 'Codeg']];
async function request(options) {
  const response = await hostFetch('/api/settings', options);
  const value = await response.json();
  if (!response.ok) throw Error(value.error || '读取监听配置失败');
  return value;
}
export async function loadListening() { return (await request()).sources; }
export async function saveListening(changes) {
  // Read at save time to preserve paths and edits from the other settings hosts.
  const latest = await request();
  for (const [id, enabled] of Object.entries(changes)) {
    if (!agents.some(([key]) => key === id) || typeof enabled !== 'boolean') throw Error('监听配置无效');
    latest.sources[id] = { ...latest.sources[id], enabled };
  }
  return (await request({method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(latest)})).sources;
}
