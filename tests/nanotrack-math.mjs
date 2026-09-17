import assert from 'node:assert/strict';
import { cropCHW, decodeResponse } from '../src/nanotrack-core.js';
(async () => {
  const image = { width: 2, height: 2, data: Uint8ClampedArray.from([10,50,90,255,20,60,100,255,30,70,110,255,40,80,120,255]) };
  assert.deepEqual([...cropCHW(image,1.5,1.5,2,2,[1,2,3])], [10,20,30,40,50,60,70,80,90,100,110,120], 'RGB planar tensor preserves raw channel values');
  assert.deepEqual([...cropCHW(image,1.5,1.5,2,1,[1,2,3])], [25,65,105], 'Bilinear resize matches half-pixel centre');
  assert.deepEqual([...cropCHW(image,.5,.5,2,2,[1,2,3])], [1,1,1,10,2,2,2,50,3,3,3,90], 'Out-of-frame pixels use channel-average padding');
  const state = { cx:100, cy:100, width:64, height:64, frameWidth:640, frameHeight:480 };
  const logits = new Float32Array(512); logits.fill(10,0,256); logits.fill(-10,256);
  const index = 9*16+10; logits[index]=-10; logits[index+256]=10;
  const distances = new Float32Array(1024).fill(32);
  const tracked = decodeResponse(logits, distances, state, 1, .8);
  assert(tracked.reliable); assert.equal(tracked.box.x,100); assert.equal(tracked.box.y,84); assert.equal(tracked.box.width,64); assert.equal(tracked.box.height,64);
  logits.fill(10,0,256);logits.fill(-10,256);
  const lost = decodeResponse(logits, distances, state, 1, .8);
  assert.equal(lost.reliable,false); assert.deepEqual(lost.box,{x:68,y:68,width:64,height:64});
  assert.deepEqual(state,{cx:100,cy:100,width:64,height:64,frameWidth:640,frameHeight:480},'Decoding does not mutate tracker state');
  console.log('PASS: RGB/CHW raw pixels, bilinear crop, border padding, stride-grid regression, low-confidence retention.');
})().catch(error => { console.error(error); process.exitCode=1; });
