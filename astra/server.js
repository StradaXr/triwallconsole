'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { WALLS, fail, wallId, boundedText, settings, fixedRules, pngDimensions, createStore } = require('./core');
const { createWorker } = require('./worker');
const ROOT = path.resolve(__dirname, '..');

function createApp(options = {}) {
  const store = createStore(options.dataDir || process.env.ASTRA_DATA_DIR || path.join(__dirname, '.local'), options.stateFile || process.env.TRIWALL_STATE);
  const { state, save } = store;
  const sessionToken = randomBytes(32).toString('hex');
  const hash = createHash('sha256');
  for (const name of ['server.js','app.js','worker.js','codex.js','core.js','index.html','astra.css']) hash.update(fs.readFileSync(path.join(__dirname,name)));
  const build = hash.digest('hex').slice(0,10);
  let worker;
  function snapshot() {
    return { ...state, rules: Object.fromEntries(WALLS.map(id => [id, fixedRules(id, state.settings.mode)])), connection: { ...(worker?.connection || { mode: 'chat-assisted', automaticGeneration: false, label: 'Generate through your ChatGPT / Codex conversation', detail: 'Queue requests here, then ask your chat to process them. The page cannot start image generation on its own.' }), dataDir: store.dataDir, projectDir: ROOT + path.sep }, build, sessionToken };
  }
  function references(wall, kind) {
    if (kind === 'refine') {
      if (!state.walls[wall].image) fail('Upload or generate an image for this wall first.');
      return [{ role: 'Edit this image; preserve everything except the requested change.', url: state.walls[wall].image }];
    }
    const refs = [];
    if (state.walls.center.image) refs.push({ role: wall === 'center' ? 'Center reference: use this to ground the center image.' : 'Center reference: match this world, lighting, palette and style.', url: state.walls.center.image });
    if (wall === 'right' && state.settings.chainSides && state.walls.left.image) refs.push({ role: 'Left reference: match its style while depicting the right-facing view.', url: state.walls.left.image });
    return refs;
  }
  function queue(wall, kind, dependsOn = null) {
    wallId(wall);
    if (!['image', 'refine', 'draft'].includes(kind)) fail('Unsupported request.');
    if (state.jobs.some(j => j.wall === wall && ['queued', 'running', 'needs-fit'].includes(j.status))) fail('This wall already has a pending request.', 409);
    if (wall !== 'center' && !state.walls.center.image && kind !== 'refine') fail('Upload or generate the center reference first.');
    const text = kind === 'refine' ? state.walls[wall].refinement : state.walls[wall].prompt;
    if (kind === 'refine' && !text.trim()) fail('Describe the change first.');
    if (!text.trim() && !state.scene.trim() && !state.walls.center.image) fail('Describe a scene or upload a reference first.');
    const job = { id: randomUUID(), wall, kind, status: 'queued', createdAt: new Date().toISOString(), settings: { ...state.settings }, scene: state.scene, prompt: text, fixedRules: fixedRules(wall, state.settings.mode), references: references(wall, kind), dependsOn, previousImage: state.walls[wall].image };
    state.jobs.unshift(job); save(); return job;
  }
  function complete(b) {
    const job = state.jobs.find(j => j.id === b.id);
    if (!job || !['queued','running','needs-fit'].includes(job.status)) fail('This request is no longer pending.', 409);
    if (job.dependsOn && state.jobs.find(j => j.id === job.dependsOn)?.status !== 'completed') fail('Complete the left wall first.', 409);
    if (job.kind === 'draft') {
      job.result = boundedText(b.prompt);
      if (!job.result) fail('The draft is empty.');
      // Preserve any text the operator edited while waiting.
      if (state.walls[job.wall].prompt === job.prompt) state.walls[job.wall].prompt = job.result;
      else job.note = 'New draft kept in request history; the wall text changed while this request was waiting.';
    } else {
      if (typeof b.data !== 'string' || !/^[a-zA-Z0-9+/=]+$/.test(b.data)) fail('Return the generated PNG as base64.');
      const bytes = Buffer.from(b.data, 'base64'), dim = pngDimensions(bytes);
      if (bytes.length > 24*1024*1024) fail('Image exceeds 24 MB.');
      if (job.status === 'needs-fit' && `${dim.width}x${dim.height}` !== job.settings.size) fail('Fit the image to the selected size.');
      if (dim.width * 9 !== dim.height * 16) fail(`Returned image is ${dim.width} × ${dim.height}, not 16:9. It was not imported or cropped.`);
      const oldImage = state.walls[job.wall].image, oldApproval = state.walls[job.wall].approved;
      const usedReferences = [...job.references];
      if (job.dependsOn) {
        const prior = state.jobs.find(j => j.id === job.dependsOn);
        const oldLeft = usedReferences.findIndex(r => r.role.startsWith('Left reference'));
        if (oldLeft !== -1) usedReferences.splice(oldLeft, 1);
        usedReferences.push({ role: 'Left reference: finished chained left wall.', url: prior.result });
      }
      const record = store.addImage(bytes, { wall: job.wall, kind: job.kind, prompt: job.prompt, scene: job.scene, fixedRules: job.fixedRules, requestedSize: job.settings.size, original: job.original || null, references: usedReferences, source: boundedText(b.source || 'ChatGPT / Codex image tool', 200) });
      job.result = record.url;
      if (oldImage !== job.previousImage) { state.walls[job.wall].image = oldImage; state.walls[job.wall].approved = oldApproval; job.note = 'Saved to the library; the current image changed while this request was waiting.'; }
      if (`${dim.width}x${dim.height}` !== job.settings.size) job.note = [job.note, `${dim.width} × ${dim.height} returned. 16:9 verified; requested ${job.settings.size}.`].filter(Boolean).join(' ');
    }
    job.status = 'completed'; job.completedAt = new Date().toISOString(); save(); worker?.drain(); return snapshot();
  }
  async function readBody(req) {
    if (!String(req.headers['content-type']).startsWith('application/json')) fail('Use JSON.', 415);
    let length = 0, chunks = [];
    for await (const chunk of req) { length += chunk.length; if (length > 32 * 1024 * 1024) fail('Upload is too large (maximum 24 MB PNG).', 413); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { fail('Invalid JSON.'); }
  }
  function send(res, code, data, type = 'application/json') {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'" });
    res.end(type === 'application/json' ? JSON.stringify(data) : data);
  }
  const server = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host || '';
      if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) fail('Local access only.', 403);
      const url = new URL(req.url, `http://${host}`), p = url.pathname;
      if (req.headers.origin && req.headers.origin !== `http://${host}`) fail('Open this console directly on localhost.', 403);
      if (req.method === 'POST') {
        if (req.headers['x-astra-token'] !== sessionToken) fail('Refresh the console and try again.', 403);
        const b = await readBody(req);
        if (p === '/api/save') {
          const nextSettings = settings(b.settings);
          const scene = boundedText(b.scene);
          const changes = WALLS.map(id => ({ id, prompt: boundedText(b.walls?.[id]?.prompt || ''), refinement: boundedText(b.walls?.[id]?.refinement || '') }));
          state.scene = scene; state.settings = nextSettings;
          for (const row of changes) Object.assign(state.walls[row.id], { prompt: row.prompt, refinement: row.refinement });
          save(); return send(res, 200, snapshot());
        }
        if (p === '/api/upload') {
          const wall = wallId(b.wall);
          if (typeof b.data !== 'string' || !/^data:image\/png;base64,[a-zA-Z0-9+/=]+$/.test(b.data)) fail('Upload a PNG, JPEG, or WebP image through the image picker.');
          const bytes = Buffer.from(b.data.split(',')[1], 'base64'); pngDimensions(bytes);
          if (bytes.length > 24 * 1024 * 1024) fail('Image exceeds 24 MB.', 413);
          store.addImage(bytes, { wall, kind: 'upload', prompt: '', source: 'Uploaded reference' });
          return send(res, 200, snapshot());
        }
        if (p === '/api/connect') { if(!worker)fail('Automatic generation is not enabled.'); await worker.connect(); worker.drain(); return send(res,200,snapshot()); }
        if (p === '/api/queue') { queue(b.wall, b.kind); worker?.drain(); return send(res, 202, snapshot()); }
        if (p === '/api/queue-sides') {
          if (!state.walls.center.image) fail('Upload or generate the center first.');
          if (state.jobs.some(j => ['left','right'].includes(j.wall) && ['queued','running','needs-fit'].includes(j.status))) fail('A side wall already has a pending request.', 409);
          const left = queue('left', 'image'); queue('right', 'image', state.settings.chainSides ? left.id : null); worker?.drain();
          return send(res, 202, snapshot());
        }
        if (p === '/api/remove-image') {
          const wall = state.walls[wallId(b.wall)];
          if (b.image !== wall.image) fail('The image changed. Refresh and try again.', 409);
          wall.image = null; wall.approved = false;
          save(); return send(res, 200, snapshot());
        }
        if (p === '/api/select') {
          const wall = wallId(b.wall), record = state.history.find(r => r.id === b.id && r.wall === wall);
          if (!record) fail('Image not found for this wall.', 404);
          store.mediaPath(record.url); state.walls[wall].image = record.url; state.walls[wall].approved = false; save(); return send(res, 200, snapshot());
        }
        if (p === '/api/approve') { const wall = wallId(b.wall); if (!state.walls[wall].image) fail('This wall has no image.'); state.walls[wall].approved = !state.walls[wall].approved; save(); return send(res, 200, snapshot()); }
        if (p === '/api/rate') { const record = state.history.find(r => r.id === b.id); if (!record) fail('Image not found.', 404); if (![null, 'up', 'down', 'perfect'].includes(b.rating)) fail('Unknown rating.'); record.rating = b.rating; save(); return send(res, 200, snapshot()); }
        if (p === '/api/cancel') { const job = state.jobs.find(j => j.id === b.id); if (!job || !['queued','running','needs-fit'].includes(job.status)) fail('This request is no longer pending.'); job.status = 'cancelled'; worker?.cancel(job.id); save(); worker?.drain(); return send(res, 200, snapshot()); }
        if (p === '/api/complete') {
          return send(res, 200, complete(b));
        }
        fail('Unknown action.', 404);
      }
      if (req.method !== 'GET') fail('Method not allowed.', 405);
      if (p === '/api/state') return send(res, 200, snapshot());
      if (p === '/api/build') return send(res, 200, { build, edition: 'astra-chat', dir: __dirname, port: server.address().port });
      if (p === '/api/queue') {
        const jobs = state.jobs.filter(j => j.status === 'queued').slice().reverse().map(j => {
          const refs = [...j.references];
          if (j.dependsOn) { const prior = state.jobs.find(x => x.id === j.dependsOn); if (prior?.status === 'completed' && prior.result?.startsWith('/media/')) { const ix = refs.findIndex(r => r.role.startsWith('Left reference')); if (ix !== -1) refs.splice(ix, 1); refs.push({ role: 'Left reference: match the finished left wall\'s style.', url: prior.result }); } }
          return { ...j, ready: !j.dependsOn || state.jobs.find(x => x.id === j.dependsOn)?.status === 'completed', references: refs.map(r => ({ ...r, path: store.mediaPath(r.url) })) };
        });
        return send(res, 200, { jobs, automatic: !!worker, workflow: worker ? 'The local Codex worker owns this queue. Do not process it concurrently from chat.' : 'Read astra/CHAT-WORKFLOW.md. Use the chat image tool; do not call external providers or paid APIs.' });
      }
      if (p === '/tri-wall.css') { const css = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').match(/<style>([\s\S]*?)<\/style>/)[1]; return send(res, 200, css, 'text/css'); }
      if (p.startsWith('/media/')) return send(res, 200, fs.readFileSync(store.mediaPath(p)), 'image/png');
      const files = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript'], '/astra.css': ['astra.css', 'text/css'] };
      if (files[p]) return send(res, 200, fs.readFileSync(path.join(__dirname, files[p][0])), files[p][1]);
      if (p === '/assets/strada-logo.svg') return send(res, 200, fs.readFileSync(path.join(ROOT, 'assets/strada-logo.svg')), 'image/svg+xml');
      fail('Not found.', 404);
    } catch (e) { if (!res.headersSent) send(res, e.status || 500, { error: e.message }); else res.end(); }
  });
  if (options.automatic) {
    worker=createWorker({store,complete,cwd:ROOT,clientFactory:options.clientFactory});
    server.on('close',()=>worker.close());
    server.on('error',()=>worker.close());
    server.on('listening',()=>worker.connect().catch(()=>{}));
  }
  return { server, store, worker };
}
if (require.main === module) {
  const { server, worker } = createApp({automatic:true});
  const port = Number(process.env.ASTRA_PORT || 8937);
  server.listen(port, '127.0.0.1', () => console.log(`Tri-Wall Astra: http://localhost:${port}/ (local Codex connection)`));
  server.on('error', e => { console.error(e.message); process.exitCode = 1; });
  for(const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>{worker.close();server.close();});
}
module.exports = { createApp };
