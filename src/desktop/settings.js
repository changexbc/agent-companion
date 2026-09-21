import {agents, loadListening, saveListening} from './listening.js';
import { loadPreferences, savePreferences } from './preferences.js';
import { createAvatar } from './avatar.js';
import { isDesktop, desktopCommand, installStandaloneWindowChrome } from './host.js';
import './settings.css';
installStandaloneWindowChrome();
document.body.insertAdjacentHTML('beforeend', `<main class="rail-settings"><header><span class="eyebrow">AGENT COMPANION</span><h1>悬浮窗设置</h1><p>让桌面上的小伙伴，按你的习惯陪伴。</p></header><form><fieldset disabled><section aria-labelledby="appearance"><h2 id="appearance">小伙伴的模样</h2><div class="styles" role="group" aria-label="头像风格"><button type="button" data-style="animal" aria-pressed="true"><span class="portraits"></span><strong>小动物</strong><small>10 种动物伙伴</small></button><button type="button" data-style="bot" aria-pressed="false"><span class="portraits"></span><strong>几何伙伴</strong><small>3 种简洁造型</small></button></div><label class="row"><span><strong>头像动画</strong><small>眨眼、转头与轻轻摇摆</small></span><input name="animation" type="checkbox" role="switch"></label><label class="row"><span><strong>默认显示数量</strong><small>更多会话收起在展开按钮中</small></span><select name="visibleCount" aria-label="默认显示数量">${Array.from({length:14},(_,i)=>`<option value="${i+3}">${i+3} 个</option>`).join('')}</select></label></section><section><h2>Agent 监听</h2><p class="section-hint">选择需要监听的 Agent，会话状态会显示在悬浮窗中。</p>${agents.map(([id, name]) => `<label class="row agent-row"><span class="agent-name"><img src="/icons/agents/${id}.png" alt=""><strong>${name}</strong></span><input name="source-${id}" type="checkbox" role="switch" aria-label="监听 ${name}" checked></label>`).join('')}</section><section><h2>启动</h2><label class="row"><span><strong>开机自启</strong><small id="login-hint">登录电脑后自动显示悬浮窗</small></span><input name="autostart" type="checkbox" role="switch"></label></section><footer><p role="status" id="save-status">正在读取设置…</p><button class="save" type="submit">保存更改</button></footer></fieldset></form><button class="retry" hidden>重新读取</button></main>`);
const form = document.querySelector('form'), fieldset = form.querySelector('fieldset'), status = document.querySelector('#save-status');
let selected = 'animal', busy = false, savedSources = {};
function fillSources(sources) { savedSources = sources; for (const [id] of agents) form.elements[`source-${id}`].checked = sources[id]?.enabled !== false; }
function selectStyle(style) { selected = style; document.querySelectorAll('[data-style]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.style === style))); }
for (const button of document.querySelectorAll('[data-style]')) {
  for (let i=0;i<3;i++) button.querySelector('.portraits').append(createAvatar(button.dataset.style,i));
  button.onclick = () => { selectStyle(button.dataset.style); status.textContent = '有未保存的更改'; };
}
form.onchange = () => { status.textContent = '有未保存的更改'; };
function fill(value) {
  selectStyle(value.avatarStyle); form.elements.animation.checked = value.animation; form.elements.visibleCount.value = value.visibleCount;
  form.elements.autostart.checked = value.autostart; form.elements.autostart.disabled = !value.autostartSupported;
  document.querySelector('#login-hint').textContent = value.autostartSupported ? '登录电脑后自动显示悬浮窗' : '请在独立桌面应用中设置';
}
async function load() {
  try { const [preferences, sources] = await Promise.all([loadPreferences(), loadListening()]); fill(preferences); fillSources(sources); fieldset.disabled = false; status.textContent = '设置保存在本机'; document.querySelector('.retry').hidden = true; }
  catch(error) { fieldset.disabled = true; status.textContent = `读取失败：${error.message || error}`; document.querySelector('.retry').hidden = false; }
}
form.onsubmit = async event => {
  event.preventDefault(); if (busy) return; busy = true; fieldset.disabled = true; status.textContent = '正在保存…';
  try {
    const changes = Object.fromEntries(agents.filter(([id]) => form.elements[`source-${id}`].checked !== savedSources[id]?.enabled).map(([id]) => [id, form.elements[`source-${id}`].checked]));
    if (Object.keys(changes).length) fillSources(await saveListening(changes));
    fill(await savePreferences({ avatarStyle: selected, visibleCount: Number(form.elements.visibleCount.value), animation: form.elements.animation.checked, autostart: form.elements.autostart.checked })); status.textContent = '已保存'; }
  catch(error) { status.textContent = `部分设置可能已保存，请重试：${error.message || error}`; }
  finally { busy = false; fieldset.disabled = false; }
};
document.querySelector('.retry').onclick = load;
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !busy && isDesktop()) desktopCommand('close_settings').catch(() => {}); });
load();
