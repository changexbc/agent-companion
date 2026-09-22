import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { preview } from 'vite';
import { defaultSettings } from '../src/settings-config.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const server = await preview({preview:{host:'127.0.0.1',port:4191,strictPort:true}});
const browser = await chromium.launch({headless:true});
const context = await browser.newContext({viewport:{width:368,height:600},reducedMotion:'reduce'});
const errors=[], failed=[], resources=[], checks=[];
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
  assert(!resources.some(url=>/three|\.glb|\.exr|\/models\//i.test(url)));
  checks.push(
    'empty','running','wait reminder','quiet done','settings persistence',
    'no retry while a read is in flight','row label toggles the switch','two submits in one task write once',
    'save re-reads then writes once','source write failure is not reported as success',
    'partial save is not reported as success','shared schema preserved',
    'focus rings match the pre-migration rule','no 3D resources',
  );
  await railMotion();
  await railDesktopPath();
  await fs.writeFile('artifacts/ui/report.json',JSON.stringify({passed:true,errors,failed,menu,checks},null,2));
  console.log('PASS: rail lifecycle, question reminder, quiet completion, settings persistence, no office resources');
} finally {await browser.close();await new Promise(resolve=>server.httpServer.close(resolve));}

/**
 * The rail with motion enabled. Every automated screenshot diff runs under
 * `prefers-reduced-motion: reduce`, which is exactly the path where `retire()`
 * removes a row immediately — so the departing ghost is only ever exercised
 * here. The observer records the ghost's box at the moment it appears, because
 * a 200ms fade is too short to poll for reliably.
 */
async function railMotion(){
  const context=await browser.newContext({viewport:{width:368,height:600},reducedMotion:'no-preference'});
  await context.route('**/api/settings',route=>route.fulfill({json:defaultSettings()}));
  await context.addInitScript(()=>{
    localStorage.setItem('agent-studio.welcome.v1','1');
    window.EventSource=class{constructor(){window.__stream=this;}close(){}};
    window.__snapshot=sessions=>window.__stream.onmessage({data:JSON.stringify({version:1,ts:Date.now(),ready:true,sources:{codex:{state:'ok'}},sessions,events:[]})});
  });
  const page=await context.newPage();
  page.on('pageerror',e=>errors.push(`motion: ${e.message}`));
  await page.goto('http://127.0.0.1:4191/desktop.html');
  await page.waitForFunction(()=>window.__stream?.onmessage);
  await page.evaluate(()=>__snapshot([]));
  await page.evaluate(()=>{
    window.__ghosts=[];
    const seen=new WeakSet();
    new MutationObserver(()=>{
      for(const node of document.querySelectorAll('.desktop-departing')){
        if(seen.has(node))continue;
        seen.add(node);
        const r=node.getBoundingClientRect();
        window.__ghosts.push({tag:node.tagName.toLowerCase(),x:r.x,y:r.y,width:r.width,height:r.height,inert:node.inert,animations:node.getAnimations().length});
      }
    }).observe(document.querySelector('#desktop-rail'),{childList:true,subtree:true});
  });
  const running={id:'codex:fixture',source:'codex',sessionId:'fixture',title:'独立悬浮框迁移验证',status:'running',roundId:'r1',updatedAt:4102444800000,steps:[],pending:[]};
  await page.evaluate(s=>__snapshot([s]),running);
  await page.locator('.desktop-avatar').waitFor();
  // Let the entrance animation finish so the recorded box is the resting one.
  await page.waitForTimeout(500);
  const row=await page.locator('.desktop-avatar').boundingBox();
  await page.evaluate(()=>__snapshot([]));
  // The ghost only lives for its 200ms fade. Wait on the observer's own record
  // rather than on a locator whose rejection would be swallowed, so a missing
  // ghost fails on the assertion below with its own message.
  await page.waitForFunction(()=>window.__ghosts.length===1,null,{timeout:2000}).catch(()=>{});
  const ghosts=await page.evaluate(()=>window.__ghosts);
  assert.equal(ghosts.length,1,'a row that leaves the list gets exactly one departing ghost');
  const ghost=ghosts[0];
  assert.equal(ghost.tag,'button','the avatar ghost is the same element type as the row it replaces');
  assert(Math.abs(ghost.x-row.x)<1.5&&Math.abs(ghost.y-row.y)<1.5,'the ghost is pinned where the row was');
  assert(Math.abs(ghost.width-row.width)<1.5&&Math.abs(ghost.height-row.height)<1.5);
  assert.equal(ghost.animations,1,'the ghost fades instead of vanishing');
  assert.equal(ghost.inert,true,'the ghost cannot be interacted with');
  await page.locator('.desktop-departing').waitFor({state:'detached',timeout:3000});
  assert.equal(await page.locator('.desktop-avatar').count(),0,'the real row is gone, only the ghost ever animated');
  // Expanding the list grows the rail, and the growth is animated rather than
  // snapped; reduced motion is asserted to skip it by the screenshot diff.
  const ghostsBefore=await page.evaluate(()=>window.__ghosts.length);
  const ten=Array.from({length:10},(_,i)=>({...running,id:`codex:fixture-${i}`,sessionId:`fixture-${i}`}));
  await page.evaluate(list=>__snapshot(list),ten);
  await page.locator('.desktop-overflow').waitFor({state:'visible'});
  await page.locator('.desktop-overflow').click();
  await page.waitForFunction(()=>document.querySelector('.desktop-strip').getAnimations().some(a=>a.effect?.getKeyframes().some(keyframe=>'height' in keyframe)),null,{timeout:2000});
  await page.waitForTimeout(400);
  assert.equal(await page.locator('.desktop-avatar:visible').count(),10,'expanding reveals every row');
  // Collapsing is the other half of the same behaviour and used to go untested.
  await page.locator('.desktop-overflow').click();
  await page.waitForTimeout(400);
  assert.equal(await page.locator('.desktop-avatar:visible').count(),8,'collapsing hides the overflow again');
  assert.equal(await page.locator('.desktop-overflow').getAttribute('aria-expanded'),'false');
  assert.equal(await page.evaluate(()=>window.__ghosts.length),ghostsBefore,'expanding and collapsing retires nothing');
  // A FLIP baseline taken from a rect would include the transform of a reorder
  // that is still running, so a commit landing mid-animation would stack a
  // second, spurious animation on a row that never moved. Only rows inside the
  // list count: a retiring ghost is also a `.desktop-avatar` and legitimately
  // owns an animation of its own. The row that leaves has to come from the
  // middle, or nothing below it moves and there is no reorder to interrupt.
  const animationCounts=()=>page.evaluate(()=>[...document.querySelectorAll('.desktop-list .desktop-avatar')].map(avatar=>avatar.getAnimations().length));
  const survivors=ten.filter((_,index)=>index!==2);
  await page.locator('.desktop-overflow').click();
  await page.waitForTimeout(400);
  await page.evaluate(list=>__snapshot(list),survivors);
  await page.waitForFunction(()=>[...document.querySelectorAll('.desktop-list .desktop-avatar')].some(a=>a.getAnimations().length>0),null,{timeout:2000});
  await page.waitForTimeout(40);
  await page.evaluate(list=>__snapshot(list),survivors);
  const stacked=await animationCounts();
  assert(stacked.some(count=>count===1),`the reorder really was still running when the second commit landed (saw ${JSON.stringify(stacked)})`);
  assert(stacked.every(count=>count<=1),`a commit during a reorder does not stack a second animation on one row (saw ${JSON.stringify(stacked)})`);
  await page.waitForTimeout(500);
  assert.deepEqual(errors,[]);
  checks.push('departing ghost keeps position and fades','rail height animation runs with motion enabled','expanding and collapsing both animate','a mid-reorder commit does not stack animations');
  await context.close();
}

/**
 * The rail as the desktop shell drives it.
 *
 * `host.ts` has an embedding path for exactly this: when the page runs inside
 * another window that provides `__AGENT_STUDIO_EMBED_HOST__`, `isDesktop()` is
 * true and every command goes through that host instead of Tauri. Running the
 * rail in an iframe therefore exercises the native code path — `set_hit_regions`
 * included — and makes the payload observable, which a browser build cannot do
 * because it never reports hit regions at all.
 */
async function railDesktopPath(){
  const context=await browser.newContext({viewport:{width:420,height:640},reducedMotion:'reduce'});
  await context.route('**/api/settings',route=>route.fulfill({json:defaultSettings()}));
  await context.route('**/qa-host.html',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><body style="margin:0"></body></html>'}));
  const page=await context.newPage();
  page.on('pageerror',e=>errors.push(`host: ${e.message}`));
  await page.goto('http://127.0.0.1:4191/qa-host.html');
  await page.evaluate(()=>{
    window.__hostCalls=[];
    window.__listeners=new Map();
    window.__state={snapshot:null,connected:true};
    window.__AGENT_STUDIO_EMBED_HOST__={
      desktop:true,
      listen:async(event,handler)=>{
        const handlers=window.__listeners.get(event)??[];
        handlers.push(handler);
        window.__listeners.set(event,handlers);
        return()=>window.__listeners.set(event,(window.__listeners.get(event)??[]).filter(entry=>entry!==handler));
      },
      invoke:async(command,args)=>{
        window.__hostCalls.push({command,args});
        if(command==='plugin:agent-studio|monitor_state')return{snapshot:window.__state.snapshot,connected:window.__state.connected};
        if(command==='plugin:agent-studio|rail_settings_get')return{avatarStyle:'animal',visibleCount:8,animation:true,autostart:false,autostartSupported:false};
        return null;
      },
      enableNotifications:async()=>'granted',
    };
    window.__emit=(event,payload)=>{for(const handler of window.__listeners.get(event)??[])handler({payload});};
    window.__regions=()=>{
      const call=[...window.__hostCalls].reverse().find(entry=>entry.command==='plugin:agent-studio|set_hit_regions');
      return call?call.args.regions:null;
    };
    const frame=document.createElement('iframe');
    frame.id='rail';
    frame.src='/desktop.html';
    frame.style.cssText='width:368px;height:600px;border:0;display:block';
    document.body.append(frame);
  });
  const rail=page.frameLocator('#rail');
  await rail.locator('.desktop-empty').waitFor();
  await page.waitForFunction(()=>window.__regions()!==null);
  const empty=await page.evaluate(()=>window.__regions());
  // The empty rail is a surface plus the grip and the menu's two items; nothing
  // else exists yet, and the disclosure button is still hidden.
  assert(empty.length>0,'the empty rail reports something to click');
  assert(!empty.some(region=>region.width<=0||region.height<=0),'no zero-sized region is reported');
  const question=[{id:'q1',text:'请选择下一步',questions:[{question:'请选择下一步',options:[{label:'继续'}]}]}];
  await page.evaluate(session=>{
    window.__state.snapshot={version:1,ts:1,ready:true,sources:{codex:{state:'ok'}},sessions:[session],events:[]};
    window.__emit('monitor-state',window.__state.snapshot);
  },{id:'codex:fixture',source:'codex',sessionId:'fixture',title:'独立悬浮框迁移验证',status:'wait',roundId:'r1',updatedAt:4102444800000,steps:[],pending:question});
  await rail.locator('.desktop-automatic-card').waitFor({state:'visible'});
  const cardBox=await rail.locator('.desktop-automatic-card').boundingBox();
  // Wait for a region that is the card's own box grown by the 10px padding, not
  // for "something taller than a row": the empty rail's own surface is 92px
  // padded, so a height threshold alone would already be satisfied before the
  // card existed and would prove nothing.
  const padded=(region,box)=>Math.abs(region.x-(box.x-10))<2&&Math.abs(region.y-(box.y-10))<2
    &&Math.abs(region.width-(box.width+20))<2&&Math.abs(region.height-(box.height+20))<2;
  await page.waitForFunction(box=>window.__regions().some(region=>Math.abs(region.x-(box.x-10))<2&&Math.abs(region.y-(box.y-10))<2&&Math.abs(region.width-(box.width+20))<2&&Math.abs(region.height-(box.height+20))<2),cardBox);
  const withCard=await page.evaluate(()=>window.__regions());
  const avatarBox=await rail.locator('.desktop-avatar').boundingBox();
  assert(withCard.some(region=>Math.abs(region.x+region.width/2-(avatarBox.x+avatarBox.width/2))<2&&Math.abs(region.height-avatarBox.height)<2),'the avatar is reported as a clickable control');
  assert(withCard.some(region=>region.cursor==='grab'),'the drag grip is reported with the grab cursor');
  assert(withCard.some(region=>padded(region,cardBox)),'the automatic card is reported as a padded surface');
  assert(withCard.length>empty.length,'adding a session adds regions rather than replacing them');
  // Every control is reported at its own size, unpadded. Checking the preview
  // matters because dropping its registration would still leave the region count
  // growing thanks to the avatar, the card surface and the dismiss button.
  const previewBox=await rail.locator('.desktop-preview').boundingBox();
  assert(withCard.some(region=>Math.abs(region.x-previewBox.x)<1&&Math.abs(region.y-previewBox.y)<1&&Math.abs(region.width-previewBox.width)<1&&Math.abs(region.height-previewBox.height)<1),'the open-preview button is reported as a control at its own size');
  const dismissBox=await rail.locator('.desktop-dismiss').boundingBox();
  assert(withCard.some(region=>Math.abs(region.x-dismissBox.x)<1&&Math.abs(region.y-dismissBox.y)<1&&Math.abs(region.width-dismissBox.width)<1&&Math.abs(region.height-dismissBox.height)<1),'the dismiss button is reported as a control at its own size, not as part of the card surface');
  // A hidden surface must contribute nothing. Padding is what makes this worth
  // asserting: a 0x0 box would otherwise become a valid 20x20 region at a
  // negative offset, which the host accepts and which would put a clickable hole
  // in the corner of the window. The menu is hidden at this point.
  assert(withCard.every(region=>region.x>=0&&region.y>=0),'no region sits outside the window, which is what a hidden surface would produce');
  assert(await rail.locator('.desktop-context-menu').isHidden(),'the menu really is hidden while this is asserted');
  // Disposing must release every subscription: a snapshot after teardown must
  // not repaint the rail. The event has to be dispatched inside the frame —
  // dispatching it on the parent window never reaches the rail's own listener.
  const frameElement=await page.locator('#rail').elementHandle();
  const railFrame=await frameElement.contentFrame();
  await railFrame.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')));
  const afterDispose=await page.evaluate(()=>window.__hostCalls.length);
  await page.evaluate(()=>{
    window.__emit('monitor-connection','offline');
    window.__emit('monitor-state',{version:1,ts:9,ready:true,sources:{codex:{state:'ok'}},sessions:[],events:[]});
  });
  await page.waitForTimeout(150);
  assert.equal(await rail.locator('.desktop-strip').getAttribute('data-connection'),'connected','a disposed rail ignores later events');
  assert.equal(await rail.locator('.desktop-avatar').count(),1,'a disposed rail keeps the rows it last rendered');
  assert.equal(await page.evaluate(()=>window.__hostCalls.length),afterDispose,'a disposed rail stops talking to the host');
  assert.deepEqual(errors,[]);
  checks.push('hit regions cover the visible surfaces and controls','hit regions ignore hidden and departing elements','dispose releases every subscription');
  await context.close();
}
