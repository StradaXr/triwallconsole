'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const { EventEmitter } = require('node:events');
const { createApp } = require('./server');
const { pngDimensions, fixedRules } = require('./core');

// Real lossless PNG fixture generated locally; no external image services.
function png(width, height) {
  function chunk(type, data) {
    const name = Buffer.from(type), payload = Buffer.concat([name, data]);
    let crc = 0xffffffff;
    for (const byte of payload) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    const prefix = Buffer.alloc(4), suffix = Buffer.alloc(4); prefix.writeUInt32BE(data.length); suffix.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([prefix, payload, suffix]);
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.alloc((width * 3 + 1) * height))), chunk('IEND', Buffer.alloc(0))]);
}

test('automatic worker: drafts, exact-ratio import, fit review, chained refs, cancellation and failure', async t => {
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'astra-worker-'));
  const calls=[];let behavior='draft';
  class FakeCodex extends EventEmitter {
    async connect(){return {model:'gpt-6-astra'};}
    close(){}
    async run(request){
      calls.push(request);
      if(behavior==='draft')return {prompt:'A snowy forest.'};
      if(behavior==='fail')throw new Error('Usage limit reached.');
      if(behavior==='wait')return new Promise((resolve,reject)=>request.signal.addEventListener('abort',()=>reject(new Error('Cancelled')),{once:true}));
      return {bytes:png(...(behavior==='fit'?[167,94]:[160,90])),source:'Test image'};
    }
  }
  const app=createApp({dataDir,stateFile:path.join(dataDir,'state.json'),automatic:true,clientFactory:()=>new FakeCodex()});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await new Promise(r=>app.server.close(r));fs.rmSync(dataDir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const get=async()=> (await fetch(base+'/api/state')).json();
  let state=await get();const token=state.sessionToken;
  const post=async(route,body)=>{const r=await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json','X-Astra-Token':token},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
  const wait=async predicate=>{for(let i=0;i<100;i++){state=await get();if(predicate(state))return state;await new Promise(r=>setTimeout(r,10));}assert.fail('Worker did not reach expected state.');};
  assert.equal(state.connection.status,'ready');
  state.scene='Snowy forest';await post('/api/save',state);
  await post('/api/queue',{wall:'center',kind:'draft'});
  await wait(s=>s.jobs[0].status==='completed');assert.equal(state.walls.center.prompt,'A snowy forest.');
  behavior='image';await post('/api/queue',{wall:'center',kind:'image'});
  await wait(s=>s.jobs[0].status==='completed');const center=state.walls.center.image;
  behavior='fit';await post('/api/queue-sides',{});
  await wait(s=>s.jobs.some(j=>j.status==='needs-fit'));
  const left=state.jobs.find(j=>j.wall==='left'),right=state.jobs.find(j=>j.wall==='right');
  assert.equal(right.status,'queued');assert.equal(state.walls.left.image,null);
  assert.equal((await post('/api/queue',{wall:'left',kind:'image'})).status,409);
  assert.deepEqual(pngDimensions(fs.readFileSync(app.store.mediaPath(left.original))),{width:167,height:94});
  assert.equal((await post('/api/complete',{id:left.id,data:png(160,90).toString('base64')})).status,400);
  behavior='image';await post('/api/complete',{id:left.id,data:png(2048,1152).toString('base64')});
  await wait(s=>s.jobs.find(j=>j.id===right.id).status==='completed');
  assert.equal(calls.at(-1).references.length,2);
  assert.equal(calls.at(-1).references[1],app.store.mediaPath(state.walls.left.image));
  assert.equal(state.history.find(r=>r.wall==='left').original,left.original);
  behavior='wait';await post('/api/queue',{wall:'center',kind:'image'});
  await wait(s=>s.jobs[0].status==='running');const cancelled=state.jobs[0].id;
  await post('/api/cancel',{id:cancelled});await wait(s=>s.jobs[0].status==='cancelled');
  assert.equal(state.walls.center.image,center);
  behavior='fail';await post('/api/queue-sides',{});
  await wait(s=>s.jobs[0].status==='blocked');assert.equal(state.jobs[1].status,'failed');assert.match(state.jobs[1].error,/Usage limit/);
  assert.equal((await post('/api/complete',{id:cancelled,data:png(160,90).toString('base64')})).status,409);
});

test('local queue, references, import checks, refinement, history and restart persistence', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-test-'));
  const app = createApp({ dataDir, stateFile: path.join(dataDir, 'state.json') });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await new Promise(resolve => app.server.close(resolve)); fs.rmSync(dataDir, { recursive:true, force:true }); });
  let state = await (await fetch(`${base}/api/state`)).json();
  const post = async (route, body, extra = {}) => {
    const response = await fetch(`${base}${route}`, { method:'POST', headers:{ 'Content-Type':'application/json', 'X-Astra-Token':state.sessionToken, ...extra }, body:JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const get = async route => (await fetch(`${base}${route}`)).json();
  assert.equal(state.connection.automaticGeneration, false);
  assert.equal((await post('/api/save', {}, { Origin:'https://example.com' })).status, 403);
  assert.equal((await post('/api/save', {}, { 'X-Astra-Token':'wrong' })).status, 403);
  assert.equal((await fetch(`${base}/media/..%2Fstate.json`)).status, 400);
  assert.equal((await post('/api/queue-sides', {})).status, 400);
  assert.equal((await post('/api/queue', {wall:'center',kind:'image'})).status, 400);
  state.scene = 'A quiet alpine lake at sunrise.';
  assert.equal((await post('/api/save', state)).status, 200);
  let queued = await post('/api/queue', {wall:'center',kind:'image'});
  assert.equal(queued.status, 202);
  const centerJob = queued.body.jobs[0];
  assert.equal((await post('/api/queue', {wall:'center',kind:'image'})).status, 409);
  assert.equal((await post('/api/complete', {id:centerJob.id,data:png(100,100).toString('base64')})).status, 400);
  assert.equal((await get('/api/state')).history.length, 0);
  let completed = await post('/api/complete', {id:centerJob.id,data:png(160,90).toString('base64')});
  assert.equal(completed.status, 200);
  state = completed.body;
  assert.equal(state.history[0].width * 9, state.history[0].height * 16);
  assert.match(state.jobs[0].note, /160 × 90/);
  const imageBytes = await (await fetch(`${base}${state.walls.center.image}`)).arrayBuffer();
  assert.deepEqual(pngDimensions(Buffer.from(imageBytes)), {width:160,height:90});
  assert.equal((await post('/api/complete', {id:centerJob.id,data:png(160,90).toString('base64')})).status,409);
  assert.equal((await post('/api/queue-sides', {})).status,202);
  let pending = (await get('/api/queue')).jobs;
  assert.equal(pending.length,2);
  const left = pending.find(j => j.wall === 'left'), right = pending.find(j => j.wall === 'right');
  assert.equal(left.ready,true); assert.equal(right.ready,false);
  assert.equal(left.references[0].url,state.walls.center.image);
  assert.ok(fs.existsSync(left.references[0].path));
  assert.equal((await post('/api/complete',{id:right.id,data:png(160,90).toString('base64')})).status,409);
  await post('/api/complete',{id:left.id,data:png(160,90).toString('base64')});
  pending = (await get('/api/queue')).jobs;
  assert.equal(pending[0].ready,true);
  assert.equal(pending[0].references.length,2);
  assert.match(pending[0].references[1].role,/Left reference/);
  await post('/api/complete',{id:right.id,data:png(160,90).toString('base64')});
  state = await get('/api/state');
  assert.equal(state.history.find(r => r.wall === 'right').references.length,2);
  state.walls.center.refinement = 'Make the light warmer.';
  await post('/api/save',state);
  const refine = (await post('/api/queue',{wall:'center',kind:'refine'})).body.jobs[0];
  assert.equal(refine.references[0].url,state.walls.center.image);
  const oldCenter = state.walls.center.image;
  await post('/api/complete',{id:refine.id,data:png(320,180).toString('base64')});
  state = await get('/api/state');
  assert.notEqual(state.walls.center.image,oldCenter);
  assert.ok(state.history.some(r => r.url === oldCenter));
  const original = state.history.find(r => r.url === oldCenter);
  await post('/api/select',{wall:'center',id:original.id});
  assert.equal((await get('/api/state')).walls.center.image,oldCenter);
  await post('/api/rate',{id:original.id,rating:'perfect'});
  assert.equal((await get('/api/state')).history.find(r => r.id === original.id).rating,'perfect');
  const draft = (await post('/api/queue',{wall:'center',kind:'draft'})).body.jobs[0];
  state = await get('/api/state'); state.walls.center.prompt = 'New operator text.'; await post('/api/save',state);
  await post('/api/complete',{id:draft.id,prompt:'Draft based on the earlier request.'});
  assert.equal((await get('/api/state')).walls.center.prompt,'New operator text.');
  const toCancel = (await post('/api/queue',{wall:'center',kind:'image'})).body.jobs[0];
  await post('/api/cancel',{id:toCancel.id});
  assert.equal((await post('/api/complete',{id:toCancel.id,data:png(160,90).toString('base64')})).status,409);
  await post('/api/queue',{wall:'center',kind:'image'});
  const reopened = createApp({dataDir,stateFile:path.join(dataDir,'state.json')});
  assert.equal(reopened.store.state.jobs[0].status,'queued');
  assert.equal(reopened.store.state.history.length,4);
  assert.ok(fixedRules('left').includes('90 degrees left'));
  assert.ok(fixedRules('right').includes('90 degrees right'));
  assert.ok(fixedRules('center').length < 3000);
  assert.equal((await fetch(`${base}/tri-wall.css`)).status,200);
  assert.equal((await fetch(`${base}/app.js`)).status,200);
});
