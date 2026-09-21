import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { preview } from 'vite';
import { defaultSettings } from '../src/settings-config.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const server = await preview({preview:{host:'127.0.0.1',port:4191,strictPort:true}});
const browser = await chromium.launch({headless:true});
const context = await browser.newContext({viewport:{width:368,height:600},reducedMotion:'reduce'});
const errors=[], failed=[], resources=[];
let settings=defaultSettings();
await context.route('**/api/settings', async route => {
  if(route.request().method()==='PUT') settings=route.request().postDataJSON();
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
  await page.goto('http://127.0.0.1:4191/desktop-settings.html');
  await page.waitForFunction(()=>document.querySelector('fieldset')?.disabled===false);
  await page.locator('button[data-style=bot]').click();
  await page.locator('select[name=visibleCount]').selectOption('5');
  await page.locator('[name=source-codex]').uncheck();
  await page.locator('button.save').click();
  await page.waitForFunction(()=>document.querySelector('#save-status').textContent==='已保存');
  await page.reload();
  await page.waitForFunction(()=>document.querySelector('fieldset')?.disabled===false);
  assert.equal(await page.locator('button[data-style=bot]').getAttribute('aria-pressed'),'true');
  assert.equal(await page.locator('select[name=visibleCount]').inputValue(),'5');
  assert.equal(await page.locator('[name=source-codex]').isChecked(),false);
  assert.deepEqual(settings.scene,defaultSettings().scene);
  await page.setViewportSize({width:480,height:700});
  await page.evaluate(()=>window.scrollTo(0,0));
  await page.screenshot({path:'artifacts/ui/settings.png',fullPage:true});
  assert.deepEqual(errors,[]);assert.deepEqual(failed,[]);
  assert(!resources.some(url=>/three|\.glb|\.exr|\/models\//i.test(url)));
  await fs.writeFile('artifacts/ui/report.json',JSON.stringify({passed:true,errors,failed,menu,checks:['empty','running','wait reminder','quiet done','settings persistence','shared schema preserved','no 3D resources'],resources},null,2));
  console.log('PASS: rail lifecycle, question reminder, quiet completion, settings persistence, no office resources');
} finally {await browser.close();await new Promise(resolve=>server.httpServer.close(resolve));}
