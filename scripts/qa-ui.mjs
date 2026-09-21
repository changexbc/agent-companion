import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { preview } from 'vite';
import { defaultSettings } from '../src/settings-config.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const server = await preview({preview:{host:'127.0.0.1',port:4191,strictPort:true}});
const browser = await chromium.launch({headless:true});
const context = await browser.newContext({viewport:{width:368,height:600},reducedMotion:'reduce'});
const errors=[], failed=[], resources=[];
// One settings route drives every scenario through flags, so the tests never
// depend on route-registration order.
// - calls records the traffic, so a save can be asserted as one re-read + one write
// - failWrites makes the source write fail
// - the first GET can be held open to observe the loading state
const calls=[];
let settings=defaultSettings();
let failWrites=false;
let holdRead=false;
let signalReadStarted=()=>{}, releaseRead=()=>{};
const readStarted=new Promise(resolve=>{signalReadStarted=resolve;});
const readReleased=new Promise(resolve=>{releaseRead=resolve;});
let held=false;
await context.route('**/api/settings', async route => {
  const method=route.request().method();
  calls.push(method);
  if(method==='GET'&&holdRead&&!held){held=true;signalReadStarted();await readReleased;}
  if(method==='PUT'){
    if(failWrites)return route.fulfill({status:500,json:{error:'磁盘写入失败'}});
    settings=route.request().postDataJSON();
  }
  await route.fulfill({json:settings});
});
await context.addInitScript(() => {
  localStorage.setItem('agent-studio.welcome.v1','1');
  window.EventSource=class {
    constructor(){ window.__stream=this; }
    close(){}
  };
  window.__snapshot=(sessions)=>window.__stream.onmessage({data:JSON.stringify({version:1,ts:Date.now(),ready:true,sources:{codex:{state:'ok'}},sessions,events:[]})});
});
const page=await context.newPage();
// Playwright's locator.isDisabled() reports false for a <fieldset> even when it is
// disabled, so read the IDL property the way src-tauri/src/native_qa.rs does.
const fieldsetDisabled=()=>page.locator('fieldset').evaluate(fieldset=>fieldset.disabled);
page.on('pageerror',e=>errors.push(e.message));
page.on('response',r=>{resources.push(r.url());if(r.status()>=400&&!r.url().endsWith('favicon.ico'))failed.push(r.url());});
await fs.mkdir('artifacts/ui',{recursive:true});
try {
  await page.goto('http://127.0.0.1:4191/desktop.html');
  await page.waitForFunction(()=>window.__stream?.onmessage);
  await page.evaluate(()=>__snapshot([]));
  await page.locator('.desktop-empty').waitFor({state:'visible'});
  await page.screenshot({path:'artifacts/ui/empty.png'});
  const session={id:'codex:fixture',source:'codex',sessionId:'fixture',title:'独立悬浮框迁移验证',status:'running',roundId:'r1',updatedAt:Date.now(),steps:[],pending:[]};
  await page.evaluate(s=>__snapshot([s]),session);
  await page.locator('.desktop-avatar[data-status=running]').waitFor();
  session.status='wait';session.pending=[{id:'q1',text:'请选择下一步',questions:[{question:'请选择下一步',options:[{label:'继续',description:'保留当前设置'},{label:'暂停'}]}]}];
  await page.evaluate(s=>__snapshot([s]),session);
  await page.locator('.desktop-automatic-card').waitFor({state:'visible'});
  assert.match(await page.locator('.desktop-automatic-card').innerText(),/请选择下一步/);
  await page.screenshot({path:'artifacts/ui/wait.png'});
  session.status='done';session.pending=[];session.endedAt=Date.now();session.updatedAt=Date.now();
  await page.evaluate(s=>__snapshot([s]),session);
  await page.locator('.desktop-avatar[data-status=done]').waitFor();
  await page.locator('.desktop-automatic-card').waitFor({state:'detached'});
  await page.screenshot({path:'artifacts/ui/done.png'});
  await page.locator('.desktop-grip').click({button:'right'});
  const menu=await page.locator('[role=menuitem]').allTextContents();
  assert(menu.includes('悬浮窗设置'));assert(!menu.some(t=>/3D|办公室/.test(t)));
  // Hold the first read open. The retry button must not be reachable while a read
  // is in flight, or a stale success can overwrite a failure the user already saw.
  holdRead=true;
  await page.goto('http://127.0.0.1:4191/desktop-settings.html');
  await readStarted;
  assert.equal(await page.locator('[data-action=retry]').count(),0,'no retry button while the first read is in flight');
  assert.equal(await fieldsetDisabled(),true,'the form is disabled while the first read is in flight');
  releaseRead();
  await page.waitForFunction(()=>document.querySelector('fieldset')?.disabled===false);
  const codexSwitch=page.locator('[data-field=source-codex]');
  assert.equal(await codexSwitch.getAttribute('aria-checked'),'true');
  await page.locator('button[data-style=bot]').click();
  await page.locator('[data-field=visibleCount]').selectOption('5');
  await codexSwitch.click();
  assert.equal(await codexSwitch.getAttribute('aria-checked'),'false');
  // The row itself is the label, so the gap between the text and the switch toggles too.
  const animationSwitch=page.locator('[data-field=animation]');
  await page.locator('label.row',{has:animationSwitch}).click({position:{x:200,y:10}});
  assert.equal(await animationSwitch.getAttribute('aria-checked'),'false','clicking the row outside the switch toggles it');
  await animationSwitch.click();
  assert.equal(await page.locator('#save-status').textContent(),'有未保存的更改');
  // Another settings host writes while this page is open; saving must not clobber it.
  settings.scene.speed=9;
  settings.sources.codex.path='/fresh/path';
  settings.notifications.sound=true;
  calls.length=0;
  // Two submissions in one task must still produce a single write.
  await page.evaluate(()=>{const form=document.querySelector('form');form.requestSubmit();form.requestSubmit();});
  await page.waitForFunction(()=>document.querySelector('#save-status').textContent==='已保存');
  assert.deepEqual(calls,['GET','PUT'],'two submissions in one task still re-read once and write once');
  assert.equal(settings.sources.codex.enabled,false);
  assert.equal(settings.scene.speed,9,'the write carries what the save-time read returned, not the page-load copy');
  assert.equal(settings.sources.codex.path,'/fresh/path');
  assert.equal(settings.notifications.sound,true);
  assert.equal(settings.scene.light,defaultSettings().scene.light,'unrelated settings survive the write');
  await page.reload();
  await page.waitForFunction(()=>document.querySelector('fieldset')?.disabled===false);
  // Focus rings are pseudo-class styles, so a default-state computed-style diff
  // cannot see them. `outline-none` next to `focus-visible:outline-2` silently
  // cancels the ring — `outline-none` sets `--tw-outline-style: none` on the
  // element and `outline-2` reads that variable back as `outline-style` — which
  // left every control with no ring, and the style cards with the browser's own
  // blue one. Assert the rule the migration replaced: `button:focus-visible,
  // input:focus-visible,select:focus-visible{outline:2px solid #477d66;
  // outline-offset:4px}`. rgb(71,125,102) is #477d66.
  // Walk the tab order here, right after the reload: a mouse click leaves
  // Chromium's sequential-focus starting point somewhere Tab no longer advances
  // from, so this has to run before the click-driven scenarios below.
  const rings=[];
  for(let i=0;i<12;i++){
    await page.keyboard.press('Tab');
    const stop=await page.evaluate(()=>{
      const el=document.activeElement;
      if(!el||el===document.body)return null;
      const s=getComputedStyle(el);
      return {tag:el.tagName.toLowerCase(),field:el.getAttribute('data-field')||el.getAttribute('data-action')||el.getAttribute('data-style')||'',ring:`${s.outlineWidth} ${s.outlineStyle} ${s.outlineColor} @${s.outlineOffset}`};
    });
    if(!stop)break;
    rings.push(stop);
  }
  assert.equal(rings.length,9,'every enabled control is reachable by Tab, and none is skipped');
  for(const stop of rings)assert.equal(stop.ring,'2px solid rgb(71, 125, 102) @4px',`${stop.tag}[${stop.field}] keeps the pre-migration focus ring`);
  assert.equal(await page.locator('button[data-style=bot]').getAttribute('aria-pressed'),'true');
  assert.equal(await page.locator('[data-field=visibleCount]').inputValue(),'5');
  assert.equal(await page.locator('[data-field=source-codex]').getAttribute('aria-checked'),'false');
  await page.setViewportSize({width:480,height:700});
  await page.evaluate(()=>window.scrollTo(0,0));
  // The switch thumb animates on load; wait it out so the screenshot is stable.
  await page.waitForTimeout(300);
  await page.screenshot({path:'artifacts/ui/settings.png',fullPage:true});
  assert.deepEqual(errors,[]);assert.deepEqual(failed,[]);
  // A failed source write must never be reported as a full success.
  failWrites=true;
  await page.locator('[data-field=source-workbuddy]').click();
  await page.locator('[data-action=save]').click();
  await page.waitForFunction(()=>/^部分设置可能已保存，请重试：/.test(document.querySelector('#save-status').textContent));
  assert.equal(await fieldsetDisabled(),false,'the form is usable again after a failed save');
  assert.equal(settings.sources.workbuddy.enabled,true,'the rejected write did not reach the server');
  // The real partial case: the source write lands, the preference write does not.
  failWrites=false;
  const storedBefore=await page.evaluate(()=>localStorage.getItem('astra.desktop.preferences.v1'));
  await page.evaluate(()=>{
    const original=Storage.prototype.setItem;
    Storage.prototype.setItem=function(key,value){
      if(key==='astra.desktop.preferences.v1')throw new Error('prefs disk');
      return original.call(this,key,value);
    };
  });
  await page.locator('[data-field=source-codeg]').click();
  calls.length=0;
  await page.locator('[data-action=save]').click();
  await page.waitForFunction(()=>/^部分设置可能已保存，请重试：/.test(document.querySelector('#save-status').textContent));
  assert.equal(settings.sources.codeg.enabled,false,'the source write really landed, so this is a partial save');
  assert.equal(await page.evaluate(()=>localStorage.getItem('astra.desktop.preferences.v1')),storedBefore,'the preference write really failed');
  assert.deepEqual(calls,['GET','PUT'],'a partial save still re-reads once and writes once');
  assert.equal(await page.locator('#save-status').textContent(),'部分设置可能已保存，请重试：prefs disk');
  assert.deepEqual(errors,[]);
  // Focus rings are pseudo-class styles, so a default-state computed-style diff
  // cannot see them. `outline-none` next to `focus-visible:outline-2` silently
  // cancels the ring — `outline-none` sets `--tw-outline-style: none` on the
  // element and `outline-2` reads that variable back as `outline-style` — which
  // left the page with no ring at all. Assert the rule the migration replaced:
  // `button:focus-visible,input:focus-visible,select:focus-visible{outline:2px
  // solid #477d66;outline-offset:4px}`. rgb(71,125,102) is #477d66.
  assert(!resources.some(url=>/three|\.glb|\.exr|\/models\//i.test(url)));
  await fs.writeFile('artifacts/ui/report.json',JSON.stringify({passed:true,errors,failed,menu,checks:['empty','running','wait reminder','quiet done','settings persistence','no retry while a read is in flight','row label toggles the switch','two submits in one task write once','save re-reads then writes once','source write failure is not reported as success','partial save is not reported as success','shared schema preserved','focus rings match the pre-migration rule','no 3D resources'],resources},null,2));
  console.log('PASS: rail lifecycle, question reminder, quiet completion, settings persistence, no office resources');
} finally {await browser.close();await new Promise(resolve=>server.httpServer.close(resolve));}
