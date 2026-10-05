import test from 'node:test';
import assert from 'node:assert/strict';
import {critterBody, critterNames, updateCritter} from '../src/desktop/critters.ts';

test('Critters use ten distinct offline portraits with independent inline SVG references', () => {
  assert.equal(critterNames.length,10);
  const bodies = critterNames.map((_,variant)=>critterBody(variant,`session-${variant}`));
  assert.equal(new Set(bodies).size,10);
  for (const [variant,body] of bodies.entries()) {
    assert(!/<script|<style|https?:|__CRITTER_ID__/.test(body));
    const ids = [...body.matchAll(/id="([^"]+)"/g)].map(match=>match[1]);
    assert.equal(ids.length,new Set(ids).size);
    for(const match of body.matchAll(/(?:href="#|url\(#)([^"\)]+)/g)) assert(ids.includes(match[1]),match[1]);
    assert(ids.every(id=>id.startsWith(`critter-session-${variant}-`)));
  }
});

test('Critters distinguish work, confirmation, completion, error and sleep without changing identity', () => {
  const eyes={dataset:{eyes:'uneven'},innerHTML:''}, mouth={innerHTML:''};
  const node={querySelector:selector=>selector==='.critter-eyes'?eyes:mouth};
  const expressions=[];
  for(const state of ['idle','running','wait','done','error','sleep','offline']){
    updateCritter(node,state);
    assert(eyes.innerHTML.length && mouth.innerHTML.length);
    expressions.push(`${eyes.innerHTML}:${mouth.innerHTML}`);
    assert.equal(eyes.dataset.eyes,'uneven');
  }
  assert.equal(new Set(expressions.slice(0,6)).size,6);
  assert.equal(expressions[5],expressions[6]);
  assert(!expressions[5].includes('<circle'),'sleeping eyes are closed');
});
