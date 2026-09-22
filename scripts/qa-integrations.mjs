import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { preview } from 'vite';
import { chromium } from 'playwright';
import { defaultSettings } from '../src/settings-config.js';

const server = await preview({preview:{host:'127.0.0.1',port:0,strictPort:true}});
const browser = await chromium.launch({headless:true});
try {
  const page = await browser.newPage({viewport:{width:480,height:760}});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let sources = ['codex','workbuddy','codebuddy-ide','codeg'].map(source => ({source,kind:source === 'codeg' ? 'webhook' : 'hooks',status:'installed',message:'配置已安装，等待事件',locations:['/tmp/test-home/.codex/hooks.json'],automatic:true,lastEventAt:null}));
  let mutations = 0, fail = false, release;
  let gate = Promise.resolve();
  await page.route('**/api/settings', route => route.fulfill({json:defaultSettings()}));
  await page.route('**/api/integrations', async route => {
    if (route.request().method() === 'POST') {
      mutations++;
      await gate;
      if (fail) return route.fulfill({status:500,json:{error:'配置不可写'}});
      const {source,action} = route.request().postDataJSON();
      sources = sources.map(item => item.source !== source ? item : {...item,automatic:action === 'install',status:action === 'install' ? 'installed' : 'not_installed',message:action === 'install' ? '配置已安装，等待事件' : '已卸载，不会自动安装'});
    }
    await route.fulfill({json:{sources}});
  });
  await page.goto(`${server.resolvedUrls.local[0]}desktop-settings.html`);
  await page.locator('[data-integration=codex]').waitFor();
  await page.locator('button[data-style=bot]').click();
  const card = page.locator('[data-integration=codex]');
  gate = new Promise(resolve => { release = resolve; });
  await card.getByRole('button',{name:'卸载',exact:true}).click();
  assert(await page.locator('[data-action=save]').isDisabled(), 'save serialized with integration mutation');
  assert(await card.getByRole('button',{name:'正在处理…'}).isDisabled());
  assert.equal(mutations,1);
  release();
  await card.getByText('未接入',{exact:true}).waitFor();
  assert.equal(await page.locator('button[data-style=bot]').getAttribute('aria-pressed'),'true','unsaved preference survives');
  assert.match(await page.locator('#save-status').innerText(),/未保存/);
  fail = true;
  await card.getByRole('button',{name:'安装 Hooks'}).click();
  await page.getByText('操作失败：配置不可写',{exact:true}).waitFor();
  assert.equal(await card.locator('.integration-badge').innerText(),'未接入');
  fail = false;
  await card.getByRole('button',{name:'安装 Hooks'}).click();
  await card.getByText('已接入',{exact:true}).waitFor();
  await page.getByRole('button',{name:'刷新状态'}).click();
  await page.getByText('状态已刷新',{exact:true}).waitFor();
  await fs.mkdir('artifacts/ui',{recursive:true});
  await page.setViewportSize({width:480,height:1800});
  await page.locator('.integration-manager').scrollIntoViewIfNeeded();
  await page.locator('.integration-manager').screenshot({path:'artifacts/ui/integrations.png'});
  for (const width of [360,480]) {
    await page.setViewportSize({width,height:760});
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),'no horizontal overflow');
  }
  assert.deepEqual(errors,[]);
  console.log('PASS: status, remove/install, failure/retry, serialization, unsaved changes, narrow geometry');
} finally { await browser.close(); await server.httpServer.close(); }
