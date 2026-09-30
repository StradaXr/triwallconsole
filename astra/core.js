'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const theatre = require('../theatre');

const WALLS = ['left', 'center', 'right'];
const SIZES = ['1536x864', '2048x1152', '2560x1440', '3840x2160'];
const QUALITIES = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODES = ['distinct', 'extension', 'panoramic'];
function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
function wallId(id) { if (!WALLS.includes(id)) fail('Choose left, center, or right.'); return id; }
function boundedText(value, max = 8000) {
  if (typeof value !== 'string' || value.length > max) fail(`Text must be under ${max} characters.`);
  return value.trim();
}
function settings(value = {}) {
  const result = { size: value.size || SIZES[1], quality: value.quality || 'high', mode: value.mode || 'distinct', chainSides: value.chainSides !== false };
  if (!SIZES.includes(result.size) || !QUALITIES.includes(result.quality) || !MODES.includes(result.mode)) fail('Unsupported image settings.');
  return result;
}
function fixedRules(id, mode = 'distinct') {
  wallId(id);
  const angle = theatre.seg(id).angleDeg;
  const orientation = id === 'center' ? 'This is the CENTER anchor image.' : `This is the ${id.toUpperCase()} wall, facing exactly ${Math.abs(angle)} degrees ${id} of the center facing direction.`;
  const common = 'Deliver one complete landscape 16:9 still image, with no triptych, borders, labels, or collage. Use a fixed, motionless viewpoint, straight-on perpendicular framing, and a spacious view with surrounding environment. Match the shared lighting, time of day, palette, materials, and style.';
  const relation = id === 'center' ? 'Establish the shared world and its main subject.' : mode === 'distinct'
    ? 'Create a distinct self-contained composition in the center reference\'s world. Do not repeat its main subject, landmark, or exact framing. Keep the ground/background boundary around 10% of the image height from the bottom.'
    : mode === 'extension' ? 'Extend the center reference\'s world into this side-facing view. Keep shared scale and lighting, without duplicating its main subject.'
    : `Compose this as the ${id} panel of a continuous panorama, matching the center reference at the adjoining edge. Continue landmarks rather than duplicating them. Match the reference horizon.`;
  return [orientation, common, relation].join('\n\n');
}
function pngDimensions(bytes) {
  if (bytes.length < 33 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.toString('ascii', 12, 16) !== 'IHDR') fail('Expected a PNG image.');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height || width * height > 40000000) fail('Image dimensions are too large.');
  return { width, height };
}
function newState() {
  return { schema: 1, scene: '', settings: settings(), walls: Object.fromEntries(WALLS.map(id => [id, { prompt: '', refinement: '', image: null, approved: false }])), history: [], jobs: [] };
}
function createStore(dataDir, stateFile = path.join(dataDir, 'state.json')) {
  fs.mkdirSync(path.join(dataDir, 'media'), { recursive: true });
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  let state = newState();
  if (fs.existsSync(stateFile)) {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (state.schema !== 1 || !WALLS.every(id => state.walls?.[id])) fail('Unsupported Astra state file. Original preserved.', 500);
    state.settings = settings(state.settings);
  }
  function save() {
    const tmp = `${stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, stateFile);
  }
  for (const job of state.jobs) if (job.status === 'running') {
    job.status = 'interrupted'; job.error = 'The server restarted. Check your provider before retrying; requests are not automatically resubmitted.';
  }
  save();
  function mediaPath(url) {
    if (typeof url !== 'string' || !/^\/media\/[a-f0-9-]+\.png$/.test(url)) fail('Unknown local image.');
    const filename = path.join(dataDir, 'media', path.basename(url));
    if (!fs.existsSync(filename)) fail('This local image is missing.', 404);
    return filename;
  }
  function addImage(bytes, metadata) {
    const dimensions = pngDimensions(bytes);
    const id = randomUUID(), url = `/media/${id}.png`;
    fs.writeFileSync(path.join(dataDir, 'media', `${id}.png`), bytes);
    const record = { id, url, ...metadata, ...dimensions, createdAt: new Date().toISOString(), rating: null };
    state.history.unshift(record);
    state.walls[metadata.wall].image = url;
    state.walls[metadata.wall].approved = false;
    save();
    return record;
  }
  return { state, save, mediaPath, addImage, dataDir, stateFile };
}
module.exports = { WALLS, SIZES, QUALITIES, MODES, fail, wallId, boundedText, settings, fixedRules, pngDimensions, createStore };
