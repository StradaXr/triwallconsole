'use strict';
const $ = id => document.getElementById(id);
const WALLS = ['left', 'center', 'right'];
let state, token, busy = false, dirty = false;
const esc = text => String(text ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const label = id => id === 'center' ? 'Center' : id[0].toUpperCase() + id.slice(1);
function notice(text, error = false) { $('notice').textContent = text; $('notice').hidden = !text; $('notice').classList.toggle('error', error); }
async function api(route, body) {
  const r = await fetch(route, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type':'application/json', 'X-Astra-Token':token }, body: JSON.stringify(body) });
  const data = await r.json(); if (!r.ok) throw new Error(data.error || 'Request failed.'); return data;
}
function tab(name) {
  document.querySelectorAll('[data-tab]').forEach(el => { const active = el.dataset.tab === name; el.classList.toggle('on', active); el.setAttribute('aria-selected', String(active)); });
  document.querySelectorAll('.tabpanel').forEach(el => el.hidden = el.id !== `panel-${name}`);
}
function cards(kind) {
  return WALLS.map(id => `<article class="wallcard ${id}"><div class="wallcard-head"><h3>${label(id)} wall</h3><span class="wall-angle">${id === 'left' ? '−90°' : id === 'right' ? '+90°' : '0° · ANCHOR'}</span><span class="pill idle" id="${kind}-status-${id}">Ready</span></div><div class="wallcard-body">
    <label class="dropzone" id="${kind}-drop-${id}" tabindex="0" aria-label="Upload ${id} reference"><div class="dz-content" id="${kind}-media-${id}"></div><input type="file" accept="image/png,image/jpeg,image/webp" id="${kind}-file-${id}"></label>
    <div class="image-toolbar" id="${kind}-toolbar-${id}"></div>
    ${kind === 'image' ? `<details><summary>Locked composition rules</summary><pre class="fixed-rules" id="rules-${id}"></pre></details>` : ''}
    <label class="prompt-tag" for="${kind}-prompt-${id}">${kind === 'image' ? 'Editable subject · your direction' : 'What would you like to change?'}</label>
    <textarea class="wallprompt" id="${kind}-prompt-${id}" placeholder="${kind === 'image' ? id === 'center' ? 'Describe the main subject, or use the shared scene above.' : 'Describe a different subject in the center’s world.' : 'For example: make the light warmer and preserve the composition.'}"></textarea>
    <div class="actions">${kind === 'image' ? `<button class="btn ghost small" data-action="draft" data-wall="${id}">Draft prompt</button>` : ''}<button class="btn small" data-action="${kind === 'image' ? 'image' : 'refine'}" data-wall="${id}">${kind === 'image' ? 'Generate image' : 'Refine image'}</button></div>
    <div class="statusline" id="${kind}-note-${id}"></div></div></article>`).join('');
}
function fillForm() {
  $('sceneInput').value = state.scene;
  for (const key of ['size', 'quality', 'mode']) $(key).value = state.settings[key];
  $('chainSides').checked = state.settings.chainSides;
  for (const id of WALLS) { $(`image-prompt-${id}`).value = state.walls[id].prompt; $(`refine-prompt-${id}`).value = state.walls[id].refinement; }
  dirty = false;
}
function render() {
  $('buildStamp').textContent = `ASTRA · ${location.port} · ${state.build}`;
  $('connectionSummary').textContent = state.connection.status === 'ready' ? 'Connected · GPT-6 Astra' : state.connection.detail;
  $('connectionDot').classList.toggle('ready',state.connection.status === 'ready');
  $('connectionDetail').textContent = state.connection.detail;
  $('storagePath').textContent = `Local images and history: ${state.connection.dataDir}`;
  $('libraryCount').textContent = state.history.length;
  for (const id of WALLS) {
    const wall = state.walls[id], record = state.history.find(r => r.url === wall.image);
    const job = state.jobs.find(j => j.wall === id && ['queued','running','needs-fit'].includes(j.status));
    $(`rules-${id}`).textContent = state.rules[id];
    for (const kind of ['image','refine']) {
      const media = $(`${kind}-media-${id}`);
      if (media.dataset.url !== (wall.image || 'empty')) {
        media.dataset.url = wall.image || 'empty';
        media.innerHTML = wall.image ? `<img src="${esc(wall.image)}" alt="${label(id)} wall reference">` : `<div class="empty"><b>${id === 'center' ? 'Start here' : label(id) + ' view'}</b><span>${id === 'center' ? 'Drop an image or click to upload<br>Or describe your scene and generate an image' : 'Drop a reference or build from the center'}</span></div>`;
      }
      $(`${kind}-toolbar-${id}`).innerHTML = wall.image ? `<span class="image-size">${record?.width || '?'} × ${record?.height || '?'}</span><a href="${esc(wall.image)}" download="${id}-wall.png">Save PNG</a><button class="btn ghost small" data-preview="${esc(wall.image)}">View</button><button class="btn ghost small" data-remove="${id}" data-image="${esc(wall.image)}" aria-label="Remove ${id} wall image" title="Clear this wall; keep the image in Library">Remove</button>` : '<span class="image-size">Landscape · 16:9 output</span>';
      const pill = $(`${kind}-status-${id}`);
      pill.textContent = job ? ({queued:'Waiting',running:'Generating', 'needs-fit':'Image ready'}[job.status]) : wall.approved ? 'Approved' : wall.image ? 'Ready' : 'Empty';
      pill.className = `pill ${job ? 'running' : wall.image ? 'completed' : 'idle'}`;
      const recent = state.jobs.find(j => j.wall === id);
      $(`${kind}-note-${id}`).textContent = job ? job.progress || 'Waiting for Codex…' : recent?.error || recent?.note || '';
    }
  }
  const queued = state.jobs.filter(j => ['queued','running','needs-fit'].includes(j.status));
  $('queueCount').textContent = queued.length;
  $('queueList').innerHTML = queued.length ? queued.slice().reverse().map(j => `<div class="queue-row"><span>${label(j.wall)} · ${esc(j.kind)} · ${esc(j.progress || (j.dependsOn ? 'Waiting for left' : 'Waiting'))}</span><div class="actions">${j.status === 'needs-fit' ? `<button class="btn ghost small" data-preview="${esc(j.original)}">View original</button><a href="${esc(j.original)}" download="${j.wall}-original.png">Save original</a><button class="btn small" data-fit="${j.id}">Fit &amp; use · ${esc(j.settings.size)}</button>` : ''}<button class="btn ghost small" data-cancel="${j.id}">Cancel</button></div></div>`).join('') : '<span class="statusline">Ready. Generate an image, draft a prompt, or refine a wall below.</span>';
  $('runQueue').textContent = state.connection.status === 'ready' ? 'Run waiting requests' : 'Connect Codex';
  $('runQueue').disabled = state.connection.status === 'connecting';
  renderLibrary();
}
function renderLibrary() {
  const filter = $('libraryFilter').value;
  const records = state.history.filter(r => filter === 'all' || r.wall === filter);
  $('library').innerHTML = records.length ? records.map(r => `<article class="library-item"><button data-preview="${esc(r.url)}" aria-label="View ${label(r.wall)} image"><img src="${esc(r.url)}" loading="lazy" alt="${label(r.wall)} wall · ${esc(r.kind)}"></button><div class="library-meta"><h3>${label(r.wall)} · ${esc(r.kind)}</h3><p>${r.width} × ${r.height} · ${esc(new Date(r.createdAt).toLocaleString())}<br>${esc(r.source)}</p>${r.prompt ? `<details><summary>Prompt</summary><p>${esc(r.prompt)}</p></details>` : ''}${r.original ? `<a href="${esc(r.original)}" download="${r.wall}-original.png">Save untouched original</a>` : ''}<div class="actions"><button class="btn ghost small" data-select="${r.id}" data-wall="${r.wall}">Use image</button><a href="${esc(r.url)}" download="${r.wall}-${r.id}.png">Save PNG</a><button class="rate-btn ${r.rating === 'up' ? 'on-up' : ''}" data-rate="up" data-id="${r.id}" aria-label="Like image">👍</button><button class="rate-btn ${r.rating === 'perfect' ? 'on-up' : ''}" data-rate="perfect" data-id="${r.id}" aria-label="Mark perfect">★</button><button class="rate-btn ${r.rating === 'down' ? 'on-down' : ''}" data-rate="down" data-id="${r.id}" aria-label="Dislike image">👎</button></div></div></article>`).join('') : '<div class="library-empty">Your images will appear here.<br><br>Upload a reference or generate an image.</div>';
}
async function save() {
  state = await api('/api/save', { scene: $('sceneInput').value, settings: { size: $('size').value, quality: $('quality').value, mode: $('mode').value, chainSides: $('chainSides').checked }, walls: Object.fromEntries(WALLS.map(id => [id, { prompt: $(`image-prompt-${id}`).value, refinement: $(`refine-prompt-${id}`).value }])) });
  token = state.sessionToken; dirty = false; $('saveStatus').textContent = 'Saved on this PC.'; render();
}
async function action(fn) {
  if (busy) return;
  busy = true;
  try { await fn(); } catch (e) { notice(e.message, true); } finally { busy = false; }
}
async function refresh(force = false) {
  const latest = await api('/api/state'); state = latest; token = latest.sessionToken;
  if (force || !dirty) fillForm(); render();
}
async function upload(id, file) {
  if (!file) return;
  if (!['image/png','image/jpeg','image/webp'].includes(file.type)) throw new Error('Choose a PNG, JPEG, or WebP image.');
  if (file.size > 24 * 1024 * 1024) throw new Error('Choose an image smaller than 24 MB.');
  const bitmap = await createImageBitmap(file);
  if (bitmap.width * bitmap.height > 40000000) { bitmap.close(); throw new Error('Image is too large. Use a reference under 40 megapixels.'); }
  const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0); bitmap.close();
  if (dirty) await save();
  state = await api('/api/upload', { wall: id, data: canvas.toDataURL('image/png') }); render(); notice(`${label(id)} reference saved.`);
}
async function fitImage(id) {
  const job = state.jobs.find(j => j.id === id);
  if (!job || job.status !== 'needs-fit') return;
  const bitmap = await createImageBitmap(await (await fetch(job.original)).blob());
  const [width,height] = job.settings.size.split('x').map(Number);
  const canvas = document.createElement('canvas'); canvas.width=width; canvas.height=height;
  const scale=Math.max(width/bitmap.width,height/bitmap.height), sw=width/scale, sh=height/scale;
  const ctx=canvas.getContext('2d');ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';
  ctx.drawImage(bitmap,(bitmap.width-sw)/2,(bitmap.height-sh)/2,sw,sh,0,0,width,height);bitmap.close();
  state=await api('/api/complete',{id,data:canvas.toDataURL('image/png').split(',')[1],source:job.source+' · fitted to '+job.settings.size});render();
  notice('Image fitted and saved. The untouched original is preserved.');
}
async function init() {
  $('imageWalls').innerHTML = cards('image'); $('refineWalls').innerHTML = cards('refine');
  document.querySelectorAll('[data-tab]').forEach(el => el.addEventListener('click', () => tab(el.dataset.tab)));
  for (const id of WALLS) for (const kind of ['image','refine']) {
    const input = $(`${kind}-file-${id}`), zone = $(`${kind}-drop-${id}`);
    input.addEventListener('change', () => action(() => upload(id, input.files[0])));
    zone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
    zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('drag'); action(() => upload(id, e.dataTransfer.files[0])); });
  }
  document.querySelectorAll('textarea, #size, #quality, #mode, #chainSides').forEach(el => el.addEventListener('input', () => { if (el.id !== 'handoffText') { dirty = true; $('saveStatus').textContent = 'Unsaved edits · saved when you queue a request.'; } }));
  $('mode').addEventListener('change', () => action(save));
  $('saveSceneBtn').addEventListener('click', () => action(save));
  $('syncBtn').addEventListener('click', () => action(async () => { if (dirty) await save(); await refresh(true); notice('Up to date.'); }));
  $('setupBtn').addEventListener('click', () => tab('connections'));
  const connect = () => action(async () => { state=await api('/api/connect',{}); render(); notice('Codex connected. Requests will run here.'); });
  $('recheck').addEventListener('click',connect);
  $('runQueue').addEventListener('click',connect);
  $('libraryFilter').addEventListener('change', renderLibrary);
  $('generateSides').addEventListener('click', () => action(async () => { await save(); state = await api('/api/queue-sides', {}); render(); notice('Side images queued. Progress and results appear here.'); }));
  $('closePreview').addEventListener('click', () => $('previewDialog').close());
  document.addEventListener('click', e => {
    const el = e.target.closest('button'); if (!el) return;
    if (el.dataset.preview) { $('previewImage').src = el.dataset.preview; $('previewDialog').showModal(); return; }
    if (el.dataset.action) action(async () => { await save(); state = await api('/api/queue', { wall: el.dataset.wall, kind: el.dataset.action }); render(); notice('Request submitted. You can stay on this page.'); });
    if (el.dataset.select) action(async () => { if (dirty) await save(); state = await api('/api/select', { id: el.dataset.select, wall: el.dataset.wall }); render(); notice('Current wall image updated.'); });
    if (el.dataset.remove) action(async () => {
      if (dirty) await save();
      state = await api('/api/remove-image', { wall: el.dataset.remove, image: el.dataset.image });
      for (const kind of ['image','refine']) $(`${kind}-file-${el.dataset.remove}`).value = '';
      render(); notice(`${label(el.dataset.remove)} image removed from the wall. Restore it anytime from Library.`);
    });
    if (el.dataset.fit) action(() => fitImage(el.dataset.fit));
    if (el.dataset.cancel) action(async () => { state = await api('/api/cancel', { id: el.dataset.cancel }); render(); });
    if (el.dataset.rate) action(async () => { const record = state.history.find(r => r.id === el.dataset.id); state = await api('/api/rate', { id: el.dataset.id, rating: record.rating === el.dataset.rate ? null : el.dataset.rate }); render(); });
  });
  await refresh(true);
  setInterval(() => { if (!busy && !document.hidden) action(() => refresh()); }, 5000);
  window.addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
}
init().catch(e => notice(e.message, true));
