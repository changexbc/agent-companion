import test from 'node:test';
import assert from 'node:assert/strict';
import { HOST_BUNDLES, HostPresence, endHostSessions, matchHost } from '../collector/lib/host-process.js';
import { Hub } from '../collector/lib/hub.js';

const PS_MAIN = '/Applications/WorkBuddy.app/Contents/MacOS/Electron\n/Applications/WorkBuddy.app/Contents/Frameworks/WorkBuddy Helper.app/Contents/MacOS/WorkBuddy Helper\n';

test('host matching requires a main executable, never a helper or crashpad leftover', () => {
  assert.equal(matchHost(PS_MAIN, HOST_BUNDLES.workbuddy), true);
  assert.equal(matchHost('/Applications/WorkBuddy AI.app/Contents/MacOS/Electron\n', HOST_BUNDLES.workbuddy), true);
  assert.equal(matchHost('/Applications/CodeBuddy.app/Contents/MacOS/CodeBuddy\n', HOST_BUNDLES['codebuddy-ide']), true);
  assert.equal(matchHost('/Applications/CodeBuddy CN.app/Contents/MacOS/Electron\n', HOST_BUNDLES['codebuddy-ide']), true);
  assert.equal(matchHost('/Applications/WorkBuddy.app/Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler\n', HOST_BUNDLES.workbuddy), false);
  assert.equal(matchHost('/Applications/CodeBuddy.app/Contents/Frameworks/CodeBuddy Helper.app/Contents/MacOS/CodeBuddy Helper\n', HOST_BUNDLES['codebuddy-ide']), false);
  assert.equal(matchHost('/Applications/CodeBuddy.app/Contents/MacOS/CodeBuddy\n', HOST_BUNDLES.workbuddy), false);
});

test('the probe debounces, caches, and never infers an exit without a sighting', async () => {
  let time = 0, calls = 0, output = '/sbin/launchd\n';
  const presence = new HostPresence({ source: 'workbuddy', now: () => time, ttlMs: 5000, minMisses: 2, run: async () => { calls++; return output; } });
  assert.equal(await presence.observe(), 'unknown');
  assert.equal(await presence.observe(), 'unknown');
  assert.equal(calls, 1, 'a second observe within the ttl must not run ps again');
  time += 5000; output = PS_MAIN;
  assert.equal(await presence.observe(), 'alive');
  time += 5000; output = '/sbin/launchd\n';
  assert.equal(await presence.observe(), 'alive', 'one miss must not declare an exit');
  time += 5000;
  assert.equal(await presence.observe(), 'gone');
  assert.equal(calls, 4);
  assert.equal(await presence.observe(), 'gone');
  assert.equal(calls, 4, 'the declared result is cached');
  output = PS_MAIN;
  presence.noteHook();
  assert.equal(await presence.observe(), 'alive', 'a hook invalidates the cached exit');
  assert.equal(calls, 5);
});

test('an unreadable process list or an unsupported platform stays unknown', async () => {
  const failing = new HostPresence({ source: 'workbuddy', now: () => 0, ttlMs: 0, minMisses: 1, run: async () => { throw Error('ps unavailable'); } });
  failing.noteHook();
  assert.equal(await failing.observe(), 'unknown');
  assert.equal(await failing.observe(), 'unknown');
  const other = new HostPresence({ source: 'workbuddy', platform: 'win32', run: async () => PS_MAIN });
  assert.equal(await other.observe(), 'unknown');
});

test('ending host sessions only touches unfinished sessions of that source', () => {
  const hub = new Hub();
  hub.ingest({ source: 'workbuddy', sessionId: 'a', roundId: 'r1', type: 'start', ts: 1 });
  hub.ingest({ source: 'workbuddy', sessionId: 'b', roundId: 'r1', type: 'end', status: 'done', ts: 2 });
  hub.ingest({ source: 'codex', sessionId: 'c', roundId: 'r1', type: 'start', ts: 3 });
  assert.equal(endHostSessions(hub, 'workbuddy', 10), 1);
  assert.equal(hub.sessions.get('workbuddy:a').status, 'aborted');
  assert.equal(hub.sessions.get('workbuddy:a').endedBy, 'host');
  assert.equal(hub.sessions.get('workbuddy:b').status, 'done');
  assert.equal(hub.sessions.get('workbuddy:b').endedBy, undefined);
  assert.equal(hub.sessions.get('codex:c').status, 'running');
  assert.equal(hub.sessions.get('codex:c').endedBy, undefined);
});
