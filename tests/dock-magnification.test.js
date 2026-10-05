import test from 'node:test';
import assert from 'node:assert/strict';
import {dockScale} from '../src/desktop/dock-magnification.ts';

test('the Dock lens is bounded, symmetric, local and smooth at its boundary', () => {
  for (const diameter of [35.2,39.6,44]) {
    assert.equal(dockScale(0,diameter),1.4);
    let previous=1.4;
    for(let distance=0;distance<diameter*3;distance+=.25){
      const value=dockScale(distance,diameter);
      assert(value>=1 && value<=1.4);
      assert(value<=previous);
      assert.equal(value,dockScale(-distance,diameter));
      previous=value;
    }
    assert.equal(dockScale(diameter*2.1,diameter),1);
    assert(dockScale(diameter*2.1-.01,diameter)<1.000001);
  }
});

test('neighboring portraits stay separate as the lens passes between them in every rail size', () => {
  for (const size of [.8,.9,1]) {
    const diameter=44*size,pitch=58*size;
    for(let pointer=-pitch;pointer<=pitch*2;pointer+=.1){
      const first=diameter*dockScale(pointer,diameter);
      const second=diameter*dockScale(pointer-pitch,diameter);
      assert((first+second)/2<=pitch, 'the two scaled circles must not overlap');
    }
    assert(dockScale(pitch,diameter)>1);
    assert.equal(dockScale(pitch*2,diameter),1);
  }
});
