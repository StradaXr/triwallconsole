#!/usr/bin/env node
// Local Tri-Wall server: serves the console page and shells out to the
// `higgsfield` CLI for the live model catalog and all generation, so the
// page always has access to every model the CLI can see — no separate
// API key, no restricted REST catalog.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const spawn = require('cross-spawn');
const RIG = require('./rig.js');
const LEARN = require('./learning.js');
const PRE = require('./preflight.js');
const CONNECT = require('./connect.js');
const PRINCIPLES = require('./principles.js');
const THEATRE = require('./theatre.js');

const PORT = process.env.TRIWALL_PORT || 8934;
const APP_DIR = __dirname;
const UPLOADS_DIR = path.join(APP_DIR, 'uploads');
const OUTPUTS_DIR = path.join(APP_DIR, 'outputs');
const REFS_DIR = path.join(APP_DIR, 'refs');        // client videos/images to decode
// TRIWALL_STATE lets a second instance run against its own state file.
// Added after a test instance started on a spare PORT wiped the live
// scene: a different port is NOT a different tool if both write the same
// state.json. Any instance that is not the real one must set this.
const STATE_FILE = process.env.TRIWALL_STATE || path.join(APP_DIR, 'state.json');

for (const dir of [UPLOADS_DIR, OUTPUTS_DIR, REFS_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// motion_probe.py needs a Python with numpy + opencv. Resolved the same
// defensive way as the other binaries rather than assumed — a backgrounded
// server does not necessarily inherit an interactive shell's PATH.
function resolvePythonBinary(){
  const envPy = process.env.TRIWALL_PYTHON;
  if (envPy && fs.existsSync(envPy)) return envPy;
  const candidates = process.platform === 'win32'
    ? ['python', 'py']
    : ['/usr/bin/python3', '/usr/local/bin/python3', 'python3'];
  for (const c of candidates) { if (!c.includes(path.sep) || fs.existsSync(c)) return c; }
  return 'python3';
}
const PYTHON_BIN = resolvePythonBinary();
const PROBE_SCRIPT = path.join(APP_DIR, 'motion_probe.py');

// On Windows, `higgsfield` resolves to a `.cmd` npm shim, which routes
// through cmd.exe and silently truncates any argument containing a
// newline at the first `\n` (confirmed: a multi-paragraph --prompt only
// ever reached Higgsfield as its first line). Invoking the native hf.exe
// underneath it directly avoids cmd.exe entirely and preserves the full
// prompt. Falls back to the plain command (relying on PATH) if the
// vendored exe isn't where npm normally puts it.
// Resolution moved to connect.js — the old version only checked %APPDATA%\npm
// (wrong on any machine whose npm global prefix is elsewhere, which is most of
// them) and otherwise returned the bare string 'higgsfield', which only works
// if npm's global bin happens to be on THIS process's PATH. That combination
// reported "not connected" on machines where the CLI was installed, and still
// failed right after installing it. See connect.js for the full list of
// layouts now checked.
//
// `let`, not `const`: the binary can appear at runtime (someone clicks Install
// in the Connections panel), and everything downstream must pick it up without
// a restart.
let HIGGSFIELD_RESOLVED = CONNECT.resolveHiggsfield();
let HIGGSFIELD_BIN = HIGGSFIELD_RESOLVED ? HIGGSFIELD_RESOLVED.bin : 'higgsfield';
function refreshHiggsfieldBinary(){
  HIGGSFIELD_RESOLVED = CONNECT.resolveHiggsfield();
  HIGGSFIELD_BIN = HIGGSFIELD_RESOLVED ? HIGGSFIELD_RESOLVED.bin : 'higgsfield';
  return HIGGSFIELD_RESOLVED;
}

// Not on the bare system PATH on this machine (confirmed: only present via
// a profile-level PATH addition, which a plain spawned process — like this
// server, started detached — doesn't necessarily inherit). Resolve an
// absolute path the same defensive way as the Higgsfield binary above,
// rather than assume `ffmpeg` just works. Used by /api/genjutsu-fix to
// mirror a reference video (see the big comment on that endpoint).
function resolveFfmpegBinary(){
  const candidates = process.platform === 'win32'
    ? ['C:\\FFmpeg\\bin\\ffmpeg.exe']
    : ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg'];
  for (const c of candidates) { if (fs.existsSync(c)) return c; }
  return 'ffmpeg'; // last resort — rely on PATH if none of the above exist
}
const FFMPEG_BIN = resolveFfmpegBinary();

function runFfmpeg(args){
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', d => err += d);
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(err.trim() || `ffmpeg exited with code ${code}`)));
  });
}

// Shared by /api/approve (images) and /api/genjutsu-fix (video) — both need
// to pull a remote Higgsfield-CDN result down to a local file before it can
// be reused as a CLI --image/--video reference for a later generation.
function downloadFile(url, dest){
  const https = require('https');
  return new Promise((resolve, reject) => {
    https.get(url, (r) => {
      if (r.statusCode !== 200) return reject(new Error(`Could not fetch ${url} (${r.statusCode})`));
      const file = fs.createWriteStream(dest);
      r.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', reject);
  });
}

// Used by /api/edit-image and /api/improve-prompt (mode 'edit') to get a
// real local file for the wall's CURRENT image — both the CLI's --image
// flag and Claude's own Read tool need an actual path, not a remote URL.
// Per the user's own workflow ("the images I want to approve are almost
// perfect, but..."), refining has to work on a freshly-generated image
// BEFORE it's been Approved (which is normally what downloads it locally —
// see /api/approve), so this can't just fall back to approvedImagePath.
// Always re-downloads genImageUrl fresh rather than caching, since an edit
// replaces genImageUrl with its own result — a second edit needs the LATEST
// version, not a stale local copy from an earlier one.
async function resolveWallLocalImagePath(wall){
  const st = state.walls[wall];
  if (st.genImageUrl) {
    const ext = path.extname(new URL(st.genImageUrl).pathname) || '.jpg';
    const dest = path.join(UPLOADS_DIR, `${wall}-current-${Date.now()}${ext}`);
    await downloadFile(st.genImageUrl, dest);
    return dest;
  }
  return st.approvedImagePath || st.uploadedImagePath || null;
}

// The video counterpart: a fresh local copy of this wall's CURRENT clip, so a
// second video refinement edits the first one's result, not the original.
async function resolveWallLocalVideoPath(wall){
  const u = state.walls[wall].genVideoUrl;
  if (!u) return null;
  const ext = path.extname(new URL(u).pathname) || '.mp4';
  const dest = path.join(UPLOADS_DIR, `${wall}-vidcurrent-${Date.now()}${ext}`);
  await downloadFile(u, dest);
  return dest;
}

const WALL_IDS = ['left', 'center', 'right'];
function defaultState() {
  const walls = {};
  WALL_IDS.forEach(id => {
    walls[id] = {
      imagePrompt: '', videoPrompt: '', editPrompt: '', videoEditPrompt: '',
      uploadedImagePath: null,
      genImageUrl: null, genImageStatus: null,
      approvedImagePath: null,
      genVideoUrl: null, genVideoStatus: null,
      // Only used by a video model whose schema exposes start_image/
      // end_image (currently MiniMax H3 / H3 Max) — see /api/generate and
      // the vidframes-* dropzones in index.html. null for every other model.
      startFramePath: null, endFramePath: null,
      // A VIDEO attached to this wall purely as a motion reference to decode
      // (a client blockout, an animatic, a previous render). Deliberately
      // separate from the image fields: decoding a camera move needs a clip,
      // and needs no still at all.
      refVideoPath: null,
    };
  });
  return {
    scene: '', imageModel: null, videoModel: null, editModel: null, videoEditModel: null,
    videoMotionMode: 'moving', videoCameraSpeedPct: 100, imageCompositionMode: 'distinct',
    // The rig spec replaces the old per-wall independent movement rules: ONE
    // physical camera intent that derives all three walls' locked blocks.
    // videoMotionMode is kept as-is so nothing that read it breaks; 'idle'
    // still maps to rig.intent 'hold'.
    rig: RIG.defaultRig(),
    decoded: null,                    // last motion_probe result, for display
    history: LEARN.emptyHistory(),
    calibration: LEARN.emptyCalibration(),
    walls,
  };
}

let state = defaultState();
if (fs.existsSync(STATE_FILE)) {
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const merged = Object.assign(defaultState(), saved);
    // Same nested-merge trap as `walls` below, for the three objects added
    // later: a state.json written before `rig`/`calibration` grew a field
    // would otherwise replace the whole default object and silently drop that
    // field's default.
    merged.rig = Object.assign(RIG.defaultRig(), saved.rig || {});
    merged.rig.element = Object.assign(RIG.defaultRig().element, (saved.rig || {}).element || {});
    merged.calibration = Object.assign(LEARN.emptyCalibration(), saved.calibration || {});
    merged.history = Object.assign(LEARN.emptyHistory(), saved.history || {});
    // Object.assign only merges TOP-LEVEL keys — `walls` is itself one such
    // key, so a saved `walls` object (written before some newer per-wall
    // field, e.g. editPrompt or startFramePath, existed) would otherwise
    // completely replace defaultState()'s walls object, silently dropping
    // that field's default rather than filling it in. Merge each wall
    // individually so an old state.json always picks up new per-wall field
    // defaults without needing to be deleted/reset.
    WALL_IDS.forEach(id => { merged.walls[id] = Object.assign(defaultState().walls[id], saved.walls?.[id] || {}); });
    state = merged;
  } catch (e) { /* corrupt or empty — start fresh */ }
}
const HISTORY_MAX = 25;          // versions kept per wall
const HISTORY_PROMPT_MAX = 2000; // characters of a submitted prompt kept

// One `hf model get` per model per process. The mode correction above needs
// the schema on every submit and the catalog does not change under us.
const MODEL_SCHEMA_CACHE = new Map();
async function modelSchema(jst) {
  if (MODEL_SCHEMA_CACHE.has(jst)) return MODEL_SCHEMA_CACHE.get(jst);
  const raw = await runCli(HIGGSFIELD_BIN, ['model', 'get', jst, '--json']);
  const parsed = JSON.parse(raw);
  MODEL_SCHEMA_CACHE.set(jst, parsed);
  return parsed;
}

const LIBRARY_MAX = 500;

function recordInLibrary(st, entry) {
  if (!Array.isArray(st.library)) st.library = [];
  if (!entry || !entry.url) return null;
  // A re-poll of the same job must not make a second row.
  if (st.library.some(r => r.url === entry.url)) return null;
  st.library.unshift(entry);           // newest first, same order as history
  if (st.library.length > LIBRARY_MAX) st.library.length = LIBRARY_MAX;
  return entry;
}

// The element's timetable for all three walls, in journey order, so the page
// can SHOW the schedule instead of working out its own version of it. The page
// had its own copy of this arithmetic and rig.js had a third; the three
// disagreed, and the one the generator actually used was whichever happened to
// be consulted last.
function elementPlan(rig) {
  const RIGSPEC = require('./rigspec.js');
  const probe = RIGSPEC.elementSchedule(rig, 'center');
  if (!probe) return null;
  return {
    order: probe.order,
    rows: probe.order.map(w => RIGSPEC.elementSchedule(rig, w)),
    notes: probe.notes,
  };
}

function pruneHistory(st) {
  if (!st || !st.history) return st;
  for (const w of Object.keys(st.history)) {
    let list = st.history[w];
    if (!Array.isArray(list)) continue;
    // NEWEST FIRST: learning.pushVersion unshifts, so index 0 is the most
    // recent version and slicing from the end would have kept the oldest and
    // thrown away today's work.
    if (list.length > HISTORY_MAX) list = list.slice(0, HISTORY_MAX);
    for (const v of list) {
      if (typeof v.promptSubmitted === 'string' && v.promptSubmitted.length > HISTORY_PROMPT_MAX) {
        v.promptSubmitted = v.promptSubmitted.slice(0, HISTORY_PROMPT_MAX)
          + '\n\n[... truncated, ' + v.promptSubmitted.length + ' characters in total]';
      }
    }
    st.history[w] = list;
  }
  return st;
}

// Identity of the code actually being served. Size plus mtime is enough to
// change on every edit and is free - no hashing of a 200KB file per request.
function buildStamp(){
  let st = { size: 0, mtimeMs: 0 };
  try { st = fs.statSync(path.join(APP_DIR, 'index.html')); } catch (e) {}
  return {
    build: String(Math.round(st.mtimeMs)).slice(-9) + '-' + st.size,
    at: st.mtimeMs ? new Date(st.mtimeMs).toISOString() : null,
    port: PORT,
    dir: APP_DIR,
    state: STATE_FILE,
  };
}

function saveState(){
  pruneHistory(state);
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// The Claude CLI prints its structured result to STDOUT and then exits
// non-zero on failure, so runCliRaw rejects with the entire JSON blob as the
// error message. That blob was being rendered verbatim in the UI — a wall of
// session ids and token counters with the one useful field, `result`, buried in
// the middle ("Not logged in · Please run /login"). Pull that out, and turn the
// auth case into something actionable.

// The locks the PAGE needs to append to its image rules, plus the geometry
// constants. Kept in one builder so the rig-rules and decode responses cannot
// drift apart.

// Measure the CENTRE wall's reference still and adopt its grade, so the locked
// grade rule can quote real numbers instead of adjectives. This is the normal
// path — a centre image, not a decoded plate — and it was the one path that
// never produced a grade reference. Runs in the background: a failure here must
// never block a generation.
async function refreshCentreGradeRef(){
  try {
    const st = state.walls.center;
    const img = st.approvedImagePath || st.uploadedImagePath;
    if (!img || !fs.existsSync(img)) return null;
    if (state.rig && state.rig.gradeRefFrom === img) return state.rig.gradeRef;
    const probe = await runProbe(img, {});
    const g = probe && probe.panels && probe.panels.CENTER && probe.panels.CENTER.grade;
    if (!g) return null;
    state.rig = state.rig || RIG.defaultRig();
    state.rig.gradeRef = g;
    state.rig.gradeRefFrom = img;
    state.rig.gradeRefHorizon = probe.panels.CENTER.horizon;
    saveState();
    return g;
  } catch (e) { return null; }
}

// A NEW centre reference means a NEW task. Two faults this fixes, both of which
// fired on the same generation and together looked like "the tool is mixing in
// the last job":
//   1. wallImagePath() prefers approvedImagePath over uploadedImagePath. Drop a
//      fresh centre frame in while an older APPROVED centre was still on record
//      and every generation silently kept using the old picture — the new one
//      was stored and then ignored.
//   2. The side walls kept their descriptions, images and videos from the
//      previous centre, so left/right went on describing a scene that no longer
//      existed anywhere in the room.
// Scope is deliberately "this picture": the motion reference video, the rig
// intent, and the learning history/calibration all survive, because none of
// them belong to the particular image on the centre wall.
// The sides always die with the old centre — they were extensions of a picture
// that is no longer on the wall.
function invalidateSidesForNewCentre(){
  ['left', 'right'].forEach(w => {
    Object.assign(state.walls[w], {
      imagePrompt: '', videoPrompt: '', editPrompt: '', videoEditPrompt: '',
      uploadedImagePath: null, approvedImagePath: null,
      genImageUrl: null, genImageStatus: null,
      genVideoUrl: null, genVideoStatus: null,
      startFramePath: null, endFramePath: null,
    });
  });
  // The grade lock was measured off the OLD centre; keeping it would hold the
  // new scene to the previous picture's colour.
  state.rig = state.rig || RIG.defaultRig();
  state.rig.gradeRef = null;
  state.rig.gradeRefFrom = null;
  state.rig.gradeRefHorizon = null;
}

// An UPLOADED centre replaces the picture outright, so the centre's own stale
// generation, approval and description go too. (On approve, by contrast, the
// centre's description is exactly what produced the image being approved —
// only the sides are stale there.)
function invalidateSceneForNewCentre(){
  const c = state.walls.center;
  c.genImageUrl = null; c.genImageStatus = null; c.approvedImagePath = null;
  c.genVideoUrl = null; c.genVideoStatus = null;
  c.imagePrompt = ''; c.videoPrompt = ''; c.editPrompt = ''; c.videoEditPrompt = '';
  c.startFramePath = null; c.endFramePath = null;
  invalidateSidesForNewCentre();
}

// Only invalidate when the centre image genuinely changed — re-uploading the
// same file (or re-approving the same generation) must not wipe work.
function centreReferenceChanged(filePath){
  try {
    const buf = fs.readFileSync(filePath);
    const hash = crypto.createHash('sha1').update(buf).digest('hex');
    if (state.centreRefHash === hash) return false;
    state.centreRefHash = hash;
    return true;
  } catch (e) { return false; }
}

function rigLockPayload(applied){
  const mode = state.imageCompositionMode || 'distinct';
  return {
    // The IMAGE locked block is now built server-side from the same principles
    // as the video one. It used to be assembled in the page, which is how the
    // old "distinct" wording survived the rewrite and let both side walls come
    // back holding a copy of the centre's billboard.
    imageRules: Object.fromEntries(WALL_IDS.map(w => [w,
      PRINCIPLES.buildImageLockedBlock(w, mode,
        RIG.buildGradeLock(applied && applied.gradeRef),
        RIG.buildMeasuredMatchRule(w, applied && applied.measured))])),
    imageModes: PRINCIPLES.IMAGE_MODES,
    imageMode: mode,
    theatre: {
      canvas: THEATRE.CANVAS,
      segments: THEATRE.SEGMENTS,
      returnsNote: THEATRE.RETURNS_NOTE,
      aspect: Object.fromEntries(WALL_IDS.map(w => [w, +THEATRE.aspect(w).toFixed(3)])),
    },
    perspective: Object.fromEntries(WALL_IDS.map(w => [w, RIG.perspectiveRule(w)])),
    grade: RIG.buildGradeLock(applied && applied.gradeRef),
    horizon: RIG.HORIZON_LOCK,
    measured: Object.fromEntries(WALL_IDS.map(w =>
      [w, RIG.buildMeasuredMatchRule(w, applied && applied.measured)])),
    geometry: RIG.RIG_GEOMETRY,
  };
}

function humaniseCliError(err){
  const raw = (err && err.message) ? String(err.message) : String(err || '');
  let result = null;
  const start = raw.indexOf('{');
  if (start !== -1) {
    try { result = JSON.parse(raw.slice(start)).result; } catch (e) {}
  }
  const msg = (result || raw).toString().trim();
  if (/not logged in|please run \/login|unauthor|invalid api key/i.test(msg)) {
    return 'Claude is not signed in on this machine, so prompts cannot be written. '
         + 'Open a terminal, run `claude`, then type /login and follow the browser prompt. '
         + 'The Connections panel at the top of the page will go green once it works.';
  }
  return msg.length > 600 ? msg.slice(0, 600) + '…' : msg;
}

// One place for the Claude invocation and its guards, shared by the
// /api/improve-prompt handler and the batch left/right drafting endpoint. The
// handoff is explicit that prompt instructions are the highest-churn, highest-
// impact part of this system and must live in ONE versioned place — two copies
// of this drifting apart is exactly how a bot ends up contradicting itself.
const PROMPT_BOT_SCHEMA = JSON.stringify({
  type: 'object',
  properties: { improved_prompt: { type: 'string' }, notes: { type: 'string' } },
  required: ['improved_prompt'],
});

// THE SCENE DRAFT IS A TYPED RESULT, NOT A STRING OF JSON.
//
// Asking the writer to "put a JSON object in improved_prompt" failed exactly
// the way a long free-text field fails: the centre wall came back
// "Expected ',' or '}' after property value ... at position 2882" - a document
// truncated mid-string. A string field has no structure for the runtime to
// enforce, so a cut-off answer is still a valid answer.
//
// Declaring the real shape moves that problem to the tool layer, where the
// model is made to retry on a mismatch. It also lets the landmark TIMESTAMPS
// be filled in by us rather than copied by the writer, which removes both the
// largest chunk of output and the most likely place for a number to drift.
const VIDEO_SCENE_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    reference_file: { type: 'string' },
    description: { type: 'string' },
    style: { type: 'string' },
    lighting: { type: 'string' },
    palette: { type: 'string' },
    foreground: { type: 'string' },
    midground: { type: 'string' },
    background: { type: 'string' },
    landmarks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          x_start: { type: 'number' },
          name: { type: 'string' },
          depth_band: { type: 'string', enum: ['foreground', 'midground', 'background'] },
        },
        required: ['x_start', 'name', 'depth_band'],
      },
    },
    seam_neighbour: { type: 'string' },
    seam_what_continues: { type: 'string' },
    seam_shared_object: { type: 'string' },
    ambient_motion: { type: 'string' },
    notes: { type: 'string' },
  },
  required: ['description', 'style', 'foreground', 'midground', 'background', 'landmarks'],
});

// Assemble the typed result into the scene half of the contract, and paste the
// contract's own landmark numbers onto the landmarks the writer named.
function sceneJsonFromDraft(d, locked) {
  // rigspec moved the landmark table to the top level when the contract was
  // cut from 9.5KB to 3KB; read it from both shapes so an older saved state
  // does not silently produce landmarks with no timestamps.
  const anchors = locked.landmarks
    || ((locked.camera && locked.camera.landmark_clock && locked.camera.landmark_clock.anchors) || []);
  const named = Array.isArray(d.landmarks) ? d.landmarks : [];
  return {
    input_reference: { file: d.reference_file || '', description: d.description || '' },
    look_and_feel: {
      style: d.style || '',
      render_quality: 'identical to the reference image; do not upgrade, restyle or re-render it',
      lighting: d.lighting || '',
      palette: d.palette || '',
    },
    geometry: {
      foreground: d.foreground || '',
      midground: d.midground || '',
      background: d.background || '',
      asset_state: '100% locked and static in world space; no flickering, no spatial shifting, '
                 + 'no restyling. Only the camera moves.',
    },
    named_landmarks: anchors.map((a, i) => {
      // Match the writer's landmark to the anchor it was asked for, by x.
      let best = null, bd = 1e9;
      for (const n of named) {
        const dd = Math.abs(Number(n.x_start) - a.x_start);
        if (dd < bd) { bd = dd; best = n; }
      }
      return {
        x_start: a.x_start,
        landmark: best ? best.name : '(not named)',
        depth_band: best ? best.depth_band : 'midground',
        x_at: a.x_at || a.x_at_timestamps,
      };
    }),
    seam_continuity: {
      neighbouring_wall: d.seam_neighbour || '',
      what_continues_across_the_join: d.seam_what_continues || '',
      shared_object: d.seam_shared_object || null,
    },
    environmental_fx: { in_scene_motion: d.ambient_motion || '' },
  };
}

async function runPromptBot(instruction, imagePath, opts){
  // --effort low: a bounded rewrite. Generous thinking budgets were observed
  // eating enough of the response that improved_prompt came back truncated
  // mid-sentence — valid JSON, incomplete string.
  const o = opts || {};
  const args = ['-p', '--no-session-persistence', '--output-format', 'json',
                '--json-schema', o.schema || PROMPT_BOT_SCHEMA, '--effort', 'low'];
  if (imagePath) args.push('--allowedTools', 'Read');
  const raw = await runCli('claude', args, instruction);
  const parsed = JSON.parse(raw);
  if (parsed.is_error) throw new Error(parsed.result || 'claude returned an error');

  // Typed mode: the whole structured_output IS the answer, and there is no
  // string to truncate. Used by the video scene draft.
  if (o.assemble) {
    const so = parsed.structured_output;
    if (!so) throw new Error('claude returned no structured result');
    return { prompt: JSON.stringify(o.assemble(so), null, 2),
             notes: so.notes || '', costUsd: parsed.total_cost_usd };
  }

  const improved = (parsed.structured_output?.improved_prompt || '').trim();
  if (!improved) throw new Error('claude returned an empty result');
  // A JSON draft is normalised here rather than downstream: if it parses, it
  // is re-emitted pretty-printed so the textarea shows something a human can
  // read and edit, and any markdown fence the model added is stripped. If it
  // does not parse, it falls through to the prose guard below - which is the
  // right outcome, because an unparseable JSON draft must not reach a
  // generation looking like a valid contract.
  const fenced = improved.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  if (fenced.startsWith('{') && fenced.endsWith('}')) {
    try {
      const obj = JSON.parse(fenced);
      return { prompt: JSON.stringify(obj, null, 2),
               notes: parsed.structured_output?.notes || '',
               costUsd: parsed.total_cost_usd };
    } catch (e) {
      throw new Error('The writer returned JSON that does not parse (' + e.message + '). Try again.');
    }
  }

  // A finished prose prompt almost always ends on terminal punctuation. Cheap
  // guard against silently saving a cut-off one; a retry costs about $0.06.
  if (!/[.!?"'）)}\]]$/.test(improved)) {
    throw new Error(`Response looks cut off (doesn't end on a complete sentence) — try again: "...${improved.slice(-60)}"`);
  }
  return { prompt: improved, notes: parsed.structured_output?.notes || '', costUsd: parsed.total_cost_usd };
}

// The AMBIENT-MOTION instruction. What a still photo cannot express is motion,
// so this writes only that — never the static scene (the image prompt already
// covers it) and never camera movement (the locked block covers it, and the bot
// is briefed on what that block says via promptBotRigContext).
function buildVideoInstruction(wall, currentPrompt, scene, imagePath, allImages){
  const NL = String.fromCharCode(10);
  const RIGSPEC = require('./rigspec.js');
  const PRINCIPLES = require('./principles.js');
  const appliedRig = LEARN.applyCalibration(state.calibration, state.rig || RIG.defaultRig());
  const moveId = RIGSPEC.normalise(appliedRig.intent);
  const dur = appliedRig.durationSec || 5;
  const locked = PRINCIPLES.buildLockedJson(wall, appliedRig);
  const anchors = locked.landmarks
    || ((locked.camera && locked.camera.landmark_clock && locked.camera.landmark_clock.anchors) || []);

  // ALL THREE WALLS, not one. The room is one space; a writer shown a single
  // frame can only guess at what crosses a seam, and cannot tell you which
  // object could travel from wall to wall.
  const imgs = (allImages || []).filter(i => i && i.path);
  const imageNote = imgs.length
    ? NL + 'THE REFERENCE IMAGES. Read every one with the Read tool before writing anything:' + NL
      + imgs.map(i => '  ' + i.wall.toUpperCase()
          + (i.wall === wall ? '  <-- THE WALL YOU ARE WRITING' : '') + ': ' + i.path).join(NL)
    : NL + 'NO REFERENCE IMAGES ARE AVAILABLE. Say so in "notes" and keep every field generic.';

  const liked = LEARN.likedExemplar(state.history, wall, 'videoPrompt', state.centreRefHash);
  const likedNote = liked
    ? NL + NL + 'A previous version of this wall was approved by the user. Match its level of detail. '
      + 'Do not copy it and do not describe anything absent from the current images:' + NL
      + liked.slice(0, 600)
    : '';

  const wantX = anchors.map(a => a.x_start.toFixed(2)).join(', ');

  return 'You are describing the SCENE for one wall of a synchronized three-wall video composition '
+ '- a U-shaped LED theatre with a LEFT, CENTRE and RIGHT wall, all seen from one seat in the '
+ 'middle. You are writing the ' + wall.toUpperCase() + ' WALL. Your answer is merged into the '
+ 'locked camera contract below and sent to a video generator.'
+ NL + NL
+ 'FILL IN THE STRUCTURED FIELDS. Do not write JSON yourself and do not write prose around your '
+ 'answer - the fields are declared for you. Keep every value short and factual; this is a spec, '
+ 'not ad copy. An earlier version of this brief asked for a JSON document in one big text field '
+ 'and it came back truncated mid-string, which is why the shape is declared now.'
+ NL + NL
+ 'THE LOCKED CAMERA CONTRACT. Already decided, merged on top of your answer, and not yours to '
+ 'change. Read it so your landmarks and depth bands line up with it:' + NL
+ JSON.stringify(locked, null, 2)
+ NL + NL
+ 'WHY THIS IS STRICT. Delivered sets have failed five ways, all avoidable: a wall travelled the '
+ 'wrong way; a wall travelled three times too far; a wall zoomed when the picture was meant to '
+ 'travel at a fixed size; a wall grew furniture, confetti and characters that were never in the '
+ 'plate; and a wall carried its foreground across a completely frozen background. Your job is to '
+ 'describe what IS there precisely enough that '
+ 'the generator has nothing left to invent, and to sort it by depth so the parallax is possible.'
+ imageNote
+ NL + NL
+ 'THE FIELDS.'
+ NL + '  reference_file  - the filename of THIS wall image.'
+ NL + '  description     - one sentence: what this wall actually shows.'
+ NL + '  style           - the medium and art style, e.g. "flat 2D vector cartoon, bold black '
+ 'outlines, cel-shaded fills" or "stylized 3D render". Take it from the image, not from the scene text.'
+ NL + '  lighting        - time of day and key light direction, from the image.'
+ NL + '  palette         - the dominant colours, from the image.'
+ NL + '  foreground / midground / background - what is actually in each depth layer of THIS image, '
+ 'named concretely. The background field matters most: it is the layer that came back frozen last '
+ 'time, so name what is in it (the back wall, the horizon, the sky, the far crowd, the distant '
+ 'structures) so the generator knows what it has to move.'
+ NL + '  landmarks       - one entry for EACH of these starting x positions: ' + wantX + '. '
+ '(x is a fraction of frame width, 0.000 = left edge, 1.000 = right edge.) For each, name a real, '
+ 'distinct, nameable thing that is actually at roughly that position in this image, and say which '
+ 'depth_band it belongs to. Do NOT compute any timestamps - those are filled in from the contract.'
+ NL + '  seam_neighbour / seam_what_continues / seam_shared_object - compare this wall image with '
+ 'the neighbouring wall image and say what is continuous across the join (a ground plane, a '
+ 'horizon, a wall surface, a light colour). Name a shared object only if one genuinely appears in '
+ 'both frames; otherwise leave it empty.'
+ NL + '  ambient_motion  - ONLY things plainly visible in this image that would move on their own '
+ 'if the shot were live, and ONLY as motion in place: something may sway, ripple, flicker, turn or '
+ 'breathe where it stands. Nothing here may travel across the frame or change its position in the '
+ 'scene - carrying the picture is the camera\'s job alone, and an element that moves against it is '
+ 'the single defect this contract exists to prevent. Leave it empty if there are none. Never add '
+ 'snow, rain, confetti, sparkles, embers, particles, birds, people or vehicles that are not '
+ 'already there.'
+ NL + '  notes           - only a genuine problem, at most one sentence.'
+ NL + NL
+ 'HARD RULES. Every value must be grounded in the reference images; never name something that is '
+ 'not there. Never introduce an object, character, effect or weather that is not visible. Do not '
+ 'contradict any value in the locked contract. Do not describe the camera - it is already specified.'
+ NL + NL
+ 'THE USER SCENE DESCRIPTION (may cover all three walls; use only the parts about THIS wall):'
+ NL + (scene || '(none given)')
+ NL + NL
+ 'WHAT THE USER WROTE IN THIS WALL DESCRIPTION BOX - an instruction to honour, not a draft to '
+ 'discard. If they asked for specific in-scene motion it belongs in ambient_motion; if they named '
+ 'a specific element it must appear in one of the geometry fields:'
+ NL + ((currentPrompt || '').trim() || '(empty - derive everything from the reference images)')
+ likedNote;
}

// Every wall image the tool currently holds, for the prompt bot to read. The
// writer was previously shown one frame and asked to describe a three-frame
// space, which is why it could never name what crosses a seam.
async function allWallImages(){
  const out = [];
  for (const w of WALL_IDS) {
    try {
      const pth = await resolveWallLocalImagePath(w);
      if (pth && fs.existsSync(pth)) out.push({ wall: w, path: pth });
    } catch (e) { /* a missing wall is reported to the bot, not fatal */ }
  }
  return out;
}

async function draftVideoPrompt(wall, imagePath){
  const st = state.walls[wall];
  const all = await allWallImages();
  const PRINCIPLES = require('./principles.js');
  const applied = LEARN.applyCalibration(state.calibration, state.rig || RIG.defaultRig());
  const locked = PRINCIPLES.buildLockedJson(wall, applied);
  return runPromptBot(
    buildVideoInstruction(wall, st.videoPrompt || '', state.scene || '', imagePath, all),
    imagePath,
    { schema: VIDEO_SCENE_SCHEMA, assemble: (d) => sceneJsonFromDraft(d, locked) });
}

function runCliRaw(binary, args, stdinInput){
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: [stdinInput != null ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error(err.trim() || out.trim() || `${binary} exited with code ${code}`));
      resolve(out.trim());
    });
    if (stdinInput != null) { child.stdin.write(stdinInput); child.stdin.end(); }
  });
}

// Running several processes at once against the same local CLI session
// appears to race (observed with `higgsfield`: --wait sometimes returns a
// bare job id instead of blocking for the result). Serialize calls to each
// binary through its own queue so that never happens.
const cliQueues = {};
// THE CLI PARSES ITS OWN ARGUMENT VALUES. `generate create <model> --name
// value` coerces each value against the model schema, which includes
// JSON-parsing anything starting with "{" or "[" - so a prompt that is a pure
// JSON document reaches the API as an object and comes back "Invalid types:
// prompt should be string, got object". Every wall failed that way on the
// first JSON build, as three paid jobs.
//
// The client already prefixes a sentence for this reason. This is the backstop
// and it lives in one function used by every path that sends a --prompt,
// because two of the three paths did not have it.
// MEASURED against higgsfield 1.1.25 with `generate cost` (free, same
// validation as create). The CLI coerces ANY value that JSON-parses, not just
// one starting with "{":
//
//     'a cat on a sofa'        -> OK, 28 credits
//     'a scene with {braces}'  -> OK, 28 credits
//     '{"a":1}'                -> Invalid types: prompt should be string, got object
//     '   {"a":1}'             -> got object   (leading SPACES are trimmed first)
//     '[1,2,3]'                -> got array
//     '12345'                  -> got number
//     'true'                   -> got boolean
//     '\n\n{"a":1}'            -> OK           (a leading NEWLINE happens to survive)
//
// The old test was /^\s*[{[]/, which missed the number and boolean cases, and
// leaned on that newline quirk being stable. Deciding it by whether the value
// actually parses as a non-string is the same question the CLI is asking, so
// the two cannot disagree.
function cliPromptArg(prompt) {
  const s = String(prompt == null ? '' : prompt);
  let coerced = false;
  try { coerced = typeof JSON.parse(s.trim()) !== 'string'; } catch (e) { coerced = false; }
  if (!coerced) return s;
  return 'Follow this JSON specification exactly. Every field is a hard requirement.'
       + String.fromCharCode(10) + String.fromCharCode(10) + s;
}

// ----------------------------------------------------- Higgsfield sign-in ---
// SIGN-IN OPENS A BROWSER, NOT A CONSOLE.
//
// This used to shell out to `cmd /c start "Higgsfield sign-in" cmd /k "<path>
// \hf.exe" auth login`. Two things wrong with that. It failed outright - the
// quoted .exe path inside `start`'s own quoting came back as
//   '"C:\...\hf.exe"' is not recognized as an internal or external command
// because `start` reads the first quoted token as the WINDOW TITLE. And even
// when it worked it was the wrong shape: a console window is not something an
// operator should have to read, and the sign-in is a browser flow anyway.
//
// So the CLI runs here instead, with its output captured. It prints the
// authorize URL and opens the browser itself; we keep the URL so the page can
// offer it as a fallback link, and we watch the process for the result.
//
// AND IT SELECTS THE WORKSPACE. Signing in is only half the job: a fresh
// account comes back with no workspace bound, and every generate call then
// fails with `workspace_membership_required` while the tool cheerfully reports
// itself signed in. That happened on a real account switch and looked exactly
// like a broken login. When the account has exactly one workspace there is
// nothing to choose, so it is chosen here.
//
// EVERY CLICK STARTS A FRESH ATTEMPT. A second Sign in used to hand back the
// attempt already pending - no new tab, and the button then waited out the
// CLI's own five-minute timeout. That happened: one attempt's tab stalled on
// Higgsfield's own sign-in page, the retry silently re-joined it, and the
// operator watched "Waiting for browser" until "Authorization timed out". A
// stuck attempt is not something anyone can finish, so a retry replaces it.
//
// THE LINK THE CLI PRINTS IS A LOCAL FILE, not the authorize URL:
//   If browser does not open, open this file in your browser: file:///C:/...
//   /higgsfield-auth-XXXX/sign-in.html
// That file is a meta-refresh to the real https authorize URL. The page cannot
// link to a file:// path, so the https URL is read out of it and offered
// instead - which is also what can be pasted into a private window when the
// normal one is stuck on a stale Higgsfield session.
let hfLogin = null, hfLoginChild = null;

function authorizeUrlFromCliOutput(buf) {
  const https = buf.match(/https:\/\/[^\s"']+/);
  if (https) return https[0];
  const file = buf.match(/file:\/\/\/?([^\s"']+sign-in\.html)/i);
  if (!file) return null;
  try {
    const html = fs.readFileSync(decodeURIComponent(file[1]), 'utf8');
    const m = html.match(/url=(https:\/\/[^"'>\s]+)/i) || html.match(/href="(https:\/\/[^"]+)"/i);
    return m ? m[1].replace(/&amp;/g, '&') : null;
  } catch (e) { return null; }
}

function beginHiggsfieldLogin() {
  if (hfLoginChild) { try { hfLoginChild.kill(); } catch (e) {} hfLoginChild = null; }
  hfLogin = { status: 'pending', url: null, message: 'Starting sign-in…',
              account: null, workspace: null, startedAt: Date.now() };
  const me = hfLogin;
  let buf = '';

  const child = spawn(HIGGSFIELD_BIN, ['auth', 'login'],
                      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  hfLoginChild = child;
  const scan = (chunk) => {
    buf += String(chunk);
    if (!me.url) {
      const u = authorizeUrlFromCliOutput(buf);
      if (u) {
        me.url = u;
        me.message = 'Browser opened — approve the sign-in there.';
      }
    }
  };
  child.stdout.on('data', scan);
  child.stderr.on('data', scan);
  child.on('error', (e) => {
    me.status = 'error';
    me.message = 'Could not start the Higgsfield CLI: ' + e.message;
  });
  child.on('close', async (code) => {
    if (hfLoginChild === child) hfLoginChild = null;
    if (me !== hfLogin) return;              // replaced by a newer attempt
    if (me.status === 'error') return;
    if (code !== 0) {
      me.status = 'error';
      me.message = buf.trim().split(String.fromCharCode(10)).filter(Boolean).slice(-1)[0]
                   || ('Sign-in exited with code ' + code);
      return;
    }
    me.message = 'Signed in. Checking workspace…';
    try {
      const raw = await runCli(HIGGSFIELD_BIN, ['workspace', 'list', '--json']);
      let list = [];
      try { const j = JSON.parse(raw); list = Array.isArray(j) ? j : (j.items || j.data || []); }
      catch (e) { list = []; }
      const selected = list.find(w => w.selected || w.is_selected);
      if (!selected && list.length === 1) {
        const id = list[0].id || list[0].workspace_id;
        if (id) await runCli(HIGGSFIELD_BIN, ['workspace', 'set', String(id)]);
      }
      const st = await runCli(HIGGSFIELD_BIN, ['workspace', 'status']).catch(() => '');
      me.workspace = String(st || '').trim().split(String.fromCharCode(10))[0] || null;
      if (!me.workspace && list.length > 1) {
        me.message = 'Signed in, but this account has ' + list.length + ' workspaces and none is '
                   + 'selected. Pick one with: higgsfield workspace set <id>';
      }
    } catch (e) { /* a workspace we could not read is reported below, not fatal */ }
    try {
      const acc = await runCli(HIGGSFIELD_BIN, ['account', 'status']);
      me.account = String(acc || '').trim().split(String.fromCharCode(10))[0] || null;
    } catch (e) { /* the account line is cosmetic */ }
    me.status = 'ok';
    if (!/workspaces and none/.test(me.message)) {
      me.message = 'Signed in' + (me.account ? ' as ' + me.account : '') + '.';
    }
  });
  return hfLogin;
}

function runCli(binary, args, stdinInput){
  if (!cliQueues[binary]) cliQueues[binary] = { queue: [], running: false };
  return new Promise((resolve, reject) => {
    cliQueues[binary].queue.push({ args, stdinInput, resolve, reject });
    pumpCliQueue(binary);
  });
}
function pumpCliQueue(binary){
  const q = cliQueues[binary];
  if (q.running || q.queue.length === 0) return;
  q.running = true;
  const { args, stdinInput, resolve, reject } = q.queue.shift();
  runCliRaw(binary, args, stdinInput)
    .then(resolve, reject)
    .finally(() => { q.running = false; pumpCliQueue(binary); });
}

function jobResultUrl(job){
  return job?.video?.url || job?.image?.url || job?.images?.[0]?.url
    || job?.result_url || job?.output?.url || job?.url || null;
}

const TERMINAL_STATUSES = ['completed', 'failed', 'nsfw', 'canceled'];

// IMPORTANT: generation jobs are never submitted with the CLI's own
// `--wait` flag. `--wait` blocks the whole `hf.exe` process until the job
// finishes — for a 4K video that can be 30-50 minutes — and since every
// higgsfield CLI call (including the simple `model list`/`model get`
// lookups that populate the page's model dropdowns) is serialized through
// one queue per binary (see runCli/pumpCliQueue above, needed because
// concurrent CLI invocations race each other), one long `--wait` call
// starves everything else on the page for its entire duration. This is
// exactly what caused "I can't choose an image or video model" — a video
// generation was mid-flight, holding the queue hostage.
//
// Instead: submit with plain `generate create ... --json` (returns almost
// immediately with the job's id), then poll `generate get <id> --json`
// ourselves in a loop with an awaited delay between each call. Each poll
// is a short, separate CLI invocation, so the queue is only ever held for
// a second or two at a time — other calls (like model list) can always
// slot in between polls, no matter how long the job itself takes.
async function pollJobUntilDone(jobId, maxWaitMs, intervalMs = 5000){
  const iterations = Math.max(1, Math.ceil(maxWaitMs / intervalMs));
  for (let i = 0; i < iterations; i++) {
    await new Promise(r => setTimeout(r, intervalMs));
    try {
      const statusRaw = await runCli(HIGGSFIELD_BIN, ['generate', 'get', jobId, '--json']);
      const job = JSON.parse(statusRaw);
      if (TERMINAL_STATUSES.includes(job.status)) return { url: jobResultUrl(job), job, timedOut: false };
    } catch (e) { /* transient CLI/network hiccup — just try again next tick */ }
  }
  return { url: null, job: null, timedOut: true, jobId };
}

// Keeps checking a job that outlived our wait budget, long after the
// triggering HTTP request has already returned. Capped generously (2h) —
// far past anything a single generation should legitimately take — purely
// as a safety net against polling forever on a job Higgsfield lost track
// of. Uses the same short-call-through-the-queue approach as
// pollJobUntilDone, so it never blocks other CLI calls either.
// `meta` fills the Library row (model, move, dials, note) the way the
// foreground path would have, so a slow job is not recorded as anonymous.
function pollJobInBackground(wall, mode, jobId, meta){
  const intervalMs = 10000;
  const maxIterations = Math.ceil(2 * 60 * 60 * 1000 / intervalMs);
  let i = 0;
  const tick = async () => {
    i++;
    try {
      const statusRaw = await runCli(HIGGSFIELD_BIN, ['generate', 'get', jobId, '--json']);
      const job = JSON.parse(statusRaw);
      if (TERMINAL_STATUSES.includes(job.status)) {
        const resultUrl = jobResultUrl(job);
        if (mode === 'image') { state.walls[wall].genImageUrl = resultUrl; state.walls[wall].genImageStatus = resultUrl ? 'completed' : 'failed'; }
        else { state.walls[wall].genVideoUrl = resultUrl; state.walls[wall].genVideoStatus = resultUrl ? 'completed' : 'failed'; }
        recordInLibrary(state, { at: new Date().toISOString(), wall, kind: mode,
                               url: state.walls[wall][mode === 'image' ? 'genImageUrl' : 'genVideoUrl'],
                               model: null, move: null, scene: (state.scene || '').slice(0, 120), ...(meta || {}) });
        saveState();
        return;
      }
    } catch (e) { /* transient CLI/network hiccup — just try again next tick */ }
    if (i < maxIterations) setTimeout(tick, intervalMs);
  };
  setTimeout(tick, intervalMs);
}

function sendJson(res, status, data){
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req){
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    req.on('data', d => { size += d.length; if (size > 60 * 1024 * 1024) { reject(new Error('Payload too large')); req.destroy(); } chunks.push(d); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp', '.mp4':'video/mp4', '.svg':'image/svg+xml', '.mov':'video/quicktime', '.webm':'video/webm' };

// Run motion_probe.py over a local media file. Not routed through runCli's
// per-binary FIFO: a probe on a long clip takes tens of seconds, and the whole
// point of that queue is that nothing slow is allowed to hold it (the `--wait`
// starvation lesson). Python gets its own concurrent invocation.

// Same spawn contract as runProbe, against verify_wall.py, which measures one
// clip with the SAME code that built the reference library.
function runVerify(clipPath){
  return new Promise((resolve, reject) => {
    // wall_motion.py, not verify_wall.py: the verdict has to be computed in
    // the same units the prompt was written in (total excursion and total
    // scale), or a clip that obeyed the spec is graded against a figure the
    // spec never asked for. See wall_motion.py's header.
    const child = spawn(PYTHON_BIN, [path.join(APP_DIR, 'wall_motion.py'), clipPath],
                        { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    child.on('error', e => reject(new Error('Could not run ' + PYTHON_BIN + ': ' + e.message)));
    child.on('close', code => {
      if (code !== 0) return reject(new Error(err.trim() || ('wall_motion exited ' + code)));
      try { resolve(JSON.parse(out.slice(out.indexOf('{')))); }
      catch (e) { reject(new Error('wall_motion returned unreadable output')); }
    });
  });
}

function runProbe(mediaPath, opts = {}){
  const args = [PROBE_SCRIPT, mediaPath, '--fov', String(opts.fov || 60)];
  if (opts.panels) args.push('--panels', String(opts.panels));
  if (opts.crop) args.push('--crop', opts.crop);
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    child.on('error', e => reject(new Error(
      `Could not run ${PYTHON_BIN}: ${e.message}. motion_probe.py needs Python with ` +
      `numpy and opencv-python-headless (pip install numpy opencv-python-headless). ` +
      `Set TRIWALL_PYTHON to an explicit interpreter path if it is not on PATH.`)));
    child.on('close', code => {
      if (code !== 0) return reject(new Error(err.trim() || `motion_probe exited ${code}`));
      try {
        // The probe prints JSON on stdout; opencv/ffmpeg can scribble warnings
        // on stderr, which is why stderr is captured separately and ignored.
        resolve(JSON.parse(out.slice(out.indexOf('{'))));
      } catch (e) { reject(new Error(`motion_probe returned unparseable output: ${out.slice(0, 300)}`)); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  try {
    // ---- static ----
    if (req.method === 'GET' && p === '/api/build') {
      return sendJson(res, 200, buildStamp());
    }
    if (req.method === 'GET' && p === '/') {
      let html = fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8');
      const stamp = buildStamp();
      // Global, not first-match: the build id appears twice - once in the
      // masthead stamp and once as the constant verifyBuild() compares
      // against. Replacing only the first left the page permanently
      // "stale" against itself and reloading in a loop.
      html = html.replace(/__TRIWALL_BUILD__/g, stamp.build)
                 .replace(/__TRIWALL_PORT__/g, String(stamp.port))
                 .replace(/__TRIWALL_DIR__/g, stamp.dir.replace(/[&<>"]/g, ''));
      html = Buffer.from(html, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': html.length,
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache',
      });
      return res.end(html);
    }
    if (req.method === 'GET' && (p.startsWith('/uploads/') || p.startsWith('/outputs/')
        || p.startsWith('/assets/') || p.startsWith('/refs/'))) {
      const safe = path.normalize(p).replace(/^(\.\.[/\\])+/, '');
      const filePath = path.join(APP_DIR, safe);
      if (!filePath.startsWith(APP_DIR) || !fs.existsSync(filePath)) { res.writeHead(404); return res.end('not found'); }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      return fs.createReadStream(filePath).pipe(res);
    }

    // ---- state ----
    // THE LIBRARY DOES NOT RIDE ALONG. It is the biggest thing in state.json
    // now that each row carries the prompt that produced it (97 rows took the
    // file from 67 KB to 313 KB), and the page never reads it from here - the
    // Library tab fetches /api/library on its own. Shipping it on every state
    // read is the same mistake README section 10 describes, where 795 KB of
    // history went out on each poll. Sent as a count so the UI can still say
    // how many there are.
    if (req.method === 'GET' && p === '/api/state') {
      const { library, ...rest } = state;
      return sendJson(res, 200, Object.assign(rest, { libraryCount: (library || []).length }));
    }

    if (req.method === 'POST' && p === '/api/scene') {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      state.scene = body.text || '';
      saveState();
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/prompt') {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      const { wall, mode, text } = body;
      if (!WALL_IDS.includes(wall) || !['image', 'video', 'edit', 'videoedit'].includes(mode)) return sendJson(res, 400, { error: 'bad wall/mode' });
      const field = mode === 'image' ? 'imagePrompt' : mode === 'video' ? 'videoPrompt'
                  : mode === 'videoedit' ? 'videoEditPrompt' : 'editPrompt';
      // Only snapshot when a non-empty prompt is actually being replaced by
      // something different — otherwise every keystroke-save would flood the
      // history with near-identical records.
      const prevText = state.walls[wall][field] || '';
      if (prevText && prevText !== (text || '')) {
        LEARN.snapshotWall(state.history, wall, state.walls[wall], 'pre-prompt', { field, sceneKey: state.centreRefHash });
      }
      state.walls[wall][field] = text || '';
      saveState();
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/model-choice') {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      if (body.imageModel !== undefined) state.imageModel = body.imageModel;
      if (body.videoModel !== undefined) state.videoModel = body.videoModel;
      if (body.editModel !== undefined) state.editModel = body.editModel;
      if (body.videoEditModel !== undefined) state.videoEditModel = body.videoEditModel;
      if (body.videoMotionMode !== undefined) state.videoMotionMode = body.videoMotionMode;
      if (body.videoCameraSpeedPct !== undefined) state.videoCameraSpeedPct = body.videoCameraSpeedPct;
      if (body.imageCompositionMode !== undefined) {
        state.imageCompositionMode = body.imageCompositionMode;
        state.imageCompositionModeChosen = true;   // marks this as a real pick, not just the default
      }
      saveState();
      return sendJson(res, 200, { ok: true });
    }

    // ---- live model catalog, straight from the CLI ----
    if (req.method === 'GET' && p === '/api/models') {
      const type = url.searchParams.get('type') || 'image';
      const raw = await runCli(HIGGSFIELD_BIN,['model', 'list', '--json']);
      const all = JSON.parse(raw);
      return sendJson(res, 200, all.filter(m => m.type === type));
    }
    if (req.method === 'GET' && p.startsWith('/api/model/')) {
      const jst = decodeURIComponent(p.slice('/api/model/'.length));
      const raw = await runCli(HIGGSFIELD_BIN,['model', 'get', jst, '--json']);
      return sendJson(res, 200, JSON.parse(raw));
    }

    // ---- upload ----
    // `field` (optional) lets the same endpoint write to a different wall
    // field than the default `uploadedImagePath` — used by the start/end
    // frame dropzones (see index.html's vidframes-* UI, MiniMax H3 only).
    // Any value other than the two frame fields falls back to the original
    // behavior, so every existing caller (the img/vid/ref dropzones) is
    // unaffected.
    if (req.method === 'POST' && p === '/api/upload') {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      const { wall, filename, dataBase64, field } = body;
      if (!WALL_IDS.includes(wall)) return sendJson(res, 400, { error: 'bad wall' });
      const targetField = ['startFramePath', 'endFramePath'].includes(field) ? field : 'uploadedImagePath';
      const ext = path.extname(filename || '') || '.jpg';
      // Keep the original filename pattern for the default (main-image)
      // case — only tag the name for the two frame fields, so an existing
      // uploaded-image filename shape doesn't change for anything already
      // relying on it.
      const safeName = targetField === 'uploadedImagePath'
        ? `${wall}-${Date.now()}${ext}`
        : `${wall}-${targetField}-${Date.now()}${ext}`;
      const dest = path.join(UPLOADS_DIR, safeName);
      fs.writeFileSync(dest, Buffer.from(dataBase64, 'base64'));
      let clearedScene = false;
      if (wall === 'center' && targetField === 'uploadedImagePath') {
        // Order matters: invalidate FIRST (it clears the stale approved centre
        // that would otherwise out-rank this upload), then record the new file.
        if (centreReferenceChanged(dest)) { invalidateSceneForNewCentre(); clearedScene = true; }
      }
      state.walls[wall][targetField] = dest;
      saveState();
      if (wall === 'center' && targetField === 'uploadedImagePath') {
        refreshCentreGradeRef().catch(() => {});
      }
      return sendJson(res, 200, { path: dest, url: `/uploads/${safeName}`, clearedScene });
    }

    // ---- generation (image or video, any model the CLI reports) ----
    if (req.method === 'POST' && p === '/api/generate') {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      const { wall, mode, jst, prompt, params, imagePath, startImagePath, endImagePath,
              extraImagePaths } = body;
      if (!WALL_IDS.includes(wall) || !['image', 'video'].includes(mode)) return sendJson(res, 400, { error: 'bad wall/mode' });

      // HARD GUARD — a side wall is defined as a continuation of the centre, so
      // generating one with no centre reference is never a valid job. Without
      // this the CLI was called with no --image at all: the model got the
      // locked block plus a line of text, invented an unrelated scene from
      // scratch, and charged for it. The client checks too, but the refusal
      // belongs here where the credits are actually spent.
      if (mode === 'video' && !imagePath && !startImagePath && !endImagePath) {
        return sendJson(res, 400, { error:
          'No reference frame for the ' + wall + ' wall. A wall clip animates that wall approved still; '
          + 'without one the model invents a scene from the text alone, which is how a set came back with '
          + 'confetti and characters nobody asked for. Generate or upload the ' + wall + ' image first.' });
      }
      if (mode === 'image' && wall !== 'center' && !imagePath) {
        return sendJson(res, 400, { error:
          'No centre reference image. The ' + wall + ' wall is an extension of the centre wall, '
          + 'so it cannot be generated until the centre has an image. Upload a centre frame (option B) '
          + 'or generate and approve the centre first.' });
      }

      // PARAM COUPLINGS THE SCHEMA DOES NOT EXPRESS. `hf model get` lists
      // extension_mode as an ordinary optional enum, but the API rejects it
      // outright unless mode is 'video_extension':
      //   'extension_mode' is only allowed for mode 'video_extension'
      // The picker offers it because the schema says it exists, so it is
      // dropped here rather than hidden there - the same param is legal on
      // other models and the rule belongs next to the call that breaks.
      // The move this job is actually being generated under, captured from
      // SERVER state at submit time. The client used to stamp the finished
      // clip with whatever the dropdown said when the result came back, so a
      // wall generated under one preset could be labelled with another if the
      // picker moved while it rendered - and a wall was, which made "the left
      // wall did not move" unreadable because the badge said C_TrackLeft.
      const appliedForJob = LEARN.applyCalibration(state.calibration, state.rig || RIG.defaultRig()) || {};
      const moveUsedForJob = require('./rigspec.js').normalise(appliedForJob.intent);

      const sendParams = Object.assign({}, params || {});
      if (sendParams.extension_mode && sendParams.mode !== 'video_extension') {
        delete sendParams.extension_mode;
      }

      // See the note above this handler. Any media at all counts: a plate, a
      // motion-lock pair, a chained side reference, or the travelling
      // element's own reference.
      const sendsMedia = !!(imagePath || startImagePath || endImagePath
                            || (Array.isArray(extraImagePaths) && extraImagePaths.filter(Boolean).length));
      let modeCorrectedTo = null;
      if (sendsMedia && sendParams.mode && sendParams.mode !== 'omni_reference') {
        let modeEnum = null;
        try {
          const sch = await modelSchema(jst);
          const mp = (sch.params || []).find(x => x.name === 'mode');
          modeEnum = mp && Array.isArray(mp.enum) ? mp.enum : null;
        } catch (e) { /* no catalog -> leave the mode alone */ }
        if (modeEnum && modeEnum.includes('omni_reference') && sendParams.mode === 't2v') {
          sendParams.mode = 'omni_reference';
          modeCorrectedTo = 'omni_reference';
        }
      }

      const args = ['generate', 'create', jst, '--prompt', cliPromptArg(prompt)];
      Object.entries(sendParams).forEach(([k, v]) => {
        if (v === '' || v === null || v === undefined) return;
        args.push(`--${k}`, String(v));
      });

      // FREE PRE-FLIGHT. `generate cost` runs the same validation as `create`
      // and returns a credit estimate without making a job, so a malformed
      // request fails in a second instead of after a paid round trip. This
      // exists because a prompt the CLI coerced into an object failed all
      // three walls at once, and the tool only found out from the job result.
      //
      // Media flags are left OUT on purpose: the CLI auto-uploads local paths,
      // and re-uploading a 3MB plate just to price it is a slow way to check
      // a type. The failures this catches are prompt type and param enums.
      //
      // AND THE MODE HAS TO GO WITH THEM. Stripping the media while keeping
      // `--mode omni_reference` asks for something self-contradictory, and the
      // model says so: "mode 'omni_reference' requires at least one reference
      // media item". That is the preflight failing a request that would have
      // succeeded, which blocked every wall from generating at all - a far
      // worse failure than the one it was added to catch. Measured on
      // seedance_2_5: dropping --mode alongside the media prices fine (28
      // credits) and still validates the prompt type and every other enum
      // (480p priced at 12, so the params really are being read).
      const MEDIA_MODES = ['omni_reference', 'video_extension', 'i2v'];
      try {
        const dropFlags = ['--image', '--start-image', '--end-image'];
        let costArgs = args.filter((a, i) =>
          !dropFlags.includes(a) && !dropFlags.includes(args[i - 1]));
        if (sendsMedia) {
          costArgs = costArgs.filter((a, i) =>
            !(a === '--mode' && MEDIA_MODES.includes(String(costArgs[i + 1]))) &&
            !(costArgs[i - 1] === '--mode' && MEDIA_MODES.includes(String(a))));
        }
        costArgs[1] = 'cost';
        const costRaw = await runCli(HIGGSFIELD_BIN, costArgs.filter(a => a !== '--json'));
        if (/Invalid|error|Error/.test(costRaw) && !/credits/i.test(costRaw)) {
          throw new Error(costRaw.trim().split(String.fromCharCode(10))[0]);
        }
      } catch (e) {
        // A complaint about missing reference media is OUR doing - we removed
        // it - so it is never a reason to refuse the real request, which does
        // carry the media.
        if (!/requires at least one reference media/i.test(String(e.message || e))) {
          const msg = String(e.message || e).trim();
          state.walls[wall][mode === 'image' ? 'genImageStatus' : 'genVideoStatus'] = 'failed';
          saveState();
          return sendJson(res, 400, { error:
            'Rejected before spending anything. The model refused these parameters: ' + msg.slice(0, 300) });
        }
      }
      // MiniMax H3 (and similar) rejects start_image/end_image mixed with a
      // normal image reference — the client only ever sends startImagePath/
      // endImagePath when the selected model actually supports them (see
      // usesStartEndFrame in index.html's generate()), in which case
      // imagePath is deliberately left null, so these three are already
      // mutually exclusive by the time they get here.
      if (startImagePath) args.push('--start-image', startImagePath);
      if (endImagePath) args.push('--end-image', endImagePath);
      if (!startImagePath && !endImagePath && imagePath) args.push('--image', imagePath);
      // REFERENCE CHAINING — the closest thing to a shared seed.
      // No Higgsfield model exposes a seed (checked across gpt_image_2/2_5,
      // flux_2, nano_banana_pro and seedance_2_0), so two sides generated from
      // the same centre still diverge in style. The CLI does accept multiple
      // image references, and a prior result can be passed as one, so the
      // second side can be anchored to the first as well as to the centre.
      (Array.isArray(extraImagePaths) ? extraImagePaths : [])
        .filter(Boolean)
        .forEach(p2 => args.push('--image', p2));
      args.push('--json'); // no --wait — see pollJobUntilDone above for why

      // 4K video genuinely takes much longer to render than 720p/1080p or
      // any still image. Our own poll budget scales to match, so a heavy
      // job gets enough runway to actually see it through before we treat
      // it as "still going, check back later" instead of failed.
      const is4k = String((params || {}).resolution || '').toLowerCase() === '4k';
      const maxWaitMs = mode === 'video' ? (is4k ? 50 * 60 * 1000 : 25 * 60 * 1000) : 12 * 60 * 1000;

      // Snapshot BEFORE the result overwrites the current one. This is the
      // whole point of the history store: iterating toward a better image used
      // to destroy the one you were iterating away from, and if the new one
      // came back worse there was nothing to go back to.
      LEARN.snapshotWall(state.history, wall, state.walls[wall], `pre-${mode}`, {
        sceneKey: state.centreRefHash, model: jst, params, promptSubmitted: prompt,
      });
      state.walls[wall][mode === 'image' ? 'genImageStatus' : 'genVideoStatus'] = 'running';
      saveState();

      try {
        const createRaw = await runCli(HIGGSFIELD_BIN, args);
        const createdParsed = JSON.parse(createRaw);
        const createdItem = Array.isArray(createdParsed) ? createdParsed[0] : createdParsed;
        // Without --wait, `generate create --json` prints just a bare job
        // id string (e.g. ["<uuid>"]) rather than a full job object — only
        // fall back to reading `.id`/`.status` off an object shape in case
        // that ever changes.
        const jobId = typeof createdItem === 'string' ? createdItem : createdItem?.id;
        if (!jobId) throw new Error(`Higgsfield didn't return a job id: ${createRaw.slice(0, 300)}`);
        const createdStatus = typeof createdItem === 'object' ? createdItem?.status : undefined;

        let resultUrl = jobResultUrl(createdItem), job = createdItem, timedOut = false;
        if (!TERMINAL_STATUSES.includes(createdStatus)) {
          ({ url: resultUrl, job, timedOut } = await pollJobUntilDone(jobId, maxWaitMs));
        }

        if (!resultUrl && timedOut) {
          // Not actually failed — it's still rendering on Higgsfield past
          // our own wait budget (routine for 4K video). Leave the wall's
          // status as "running" rather than falsely reporting "failed",
          // and keep polling in the background so state.json (and the
          // page, next time it syncs) picks up the real outcome once the
          // job actually finishes, with no further action needed here.
          pollJobInBackground(wall, mode, jobId, {
            model: jst, move: mode === 'video' ? moveUsedForJob : null,
            speedPct: mode === 'video' ? appliedForJob.speedPct : null,
            centrePct: mode === 'video' ? (appliedForJob.centrePct || 100) : null,
            durationSec: (params || {}).duration || null, resolution: (params || {}).resolution || null,
          });
          return sendJson(res, 200, { url: null, job, jobId, timedOut: true, moveUsed: moveUsedForJob,
            note: `Still rendering on Higgsfield past our own check-in window — normal for 4K video. Status will update to completed/failed automatically once it finishes; click "Sync from chat" or reload to check.` });
        }
        if (mode === 'image') { state.walls[wall].genImageUrl = resultUrl; state.walls[wall].genImageStatus = resultUrl ? 'completed' : 'failed'; }
        else { state.walls[wall].genVideoUrl = resultUrl; state.walls[wall].genVideoStatus = resultUrl ? 'completed' : 'failed'; }
        if (resultUrl) {
          recordInLibrary(state, {
            at: new Date().toISOString(), wall, kind: mode, url: resultUrl,
            model: jst, move: mode === 'video' ? moveUsedForJob : null,
            // The dials this clip's contract was written with, so Check
            // against preset can measure it against ITS ask, not whatever the
            // dials say by the time someone presses the button.
            speedPct: mode === 'video' ? appliedForJob.speedPct : null,
            centrePct: mode === 'video' ? (appliedForJob.centrePct || 100) : null,
            durationSec: (params || {}).duration || null,
            resolution: (params || {}).resolution || null,
            scene: (state.scene || '').slice(0, 120),
            note: modeCorrectedTo ? ('mode auto-set to ' + modeCorrectedTo) : null,
          });
        }
        saveState();
        return sendJson(res, 200, { url: resultUrl, job, moveUsed: moveUsedForJob,
                                    modeCorrectedTo });
      } catch (err) {
        state.walls[wall][mode === 'image' ? 'genImageStatus' : 'genVideoStatus'] = 'failed';
        saveState();
        return sendJson(res, 500, { error: err.message });
      }
    }

    // Genuine Claude-quality prompt improvement, run locally via the
    // standalone `claude` CLI (authenticated via `claude auth login` against
    // the user's own Claude account — no separate API key). When a reference
    // image path is given, Claude actually reads the file (its own Read
    // tool) rather than guessing at its contents.
    //
    // Two Windows-specific gotchas discovered the hard way, both handled
    // below: (1) the prompt MUST go over stdin, not as a positional CLI
    // argument — a `.cmd` shim invocation silently truncates/corrupts any
    // argument containing a newline; (2) naming "Higgsfield"/"three-wall"
    // in the instruction makes this org's Claude account auto-reference an
    // unauthorized MCP connector instead of just doing the task, so the
    // wording below stays generic ("an AI image/video generator").
    if (req.method === 'POST' && p === '/api/improve-prompt') {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      const { wall, mode, currentPrompt, scene, compositionMode } = body;
      let { imagePath } = body;
      if (!WALL_IDS.includes(wall) || !['image', 'video', 'edit', 'videoedit'].includes(mode)) return sendJson(res, 400, { error: 'bad wall/mode' });

      // REFUSE RATHER THAN INVENT. A side wall's description is, by definition,
      // derived from the centre image. With no readable centre the bot still
      // answered 200 with fluent, completely content-free filler — "whatever
      // ground, floor or terrain plane is visible in the reference" — which
      // reads like a real description and silently produced unrelated images.
      // A plausible answer to a question it could not see is worse than an
      // error, so this is an error.
      if (mode === 'image' && wall !== 'center') {
        if (!imagePath) {
          return sendJson(res, 400, { error:
            'No centre reference image, so there is nothing to describe an extension of. '
            + 'Put the reference on the CENTER WALL card first — the side walls are derived from it.' });
        }
        if (!fs.existsSync(imagePath)) {
          return sendJson(res, 400, { error:
            'The centre reference image is no longer on disk (' + path.basename(imagePath) + '). '
            + 'Re-upload it to the centre wall.' });
        }
      }

      // 'edit' mode always resolves (and, if needed, downloads) the wall's
      // OWN current image itself, ignoring whatever the client sent — the
      // client only knows a display URL, not a real local path, and edit
      // mode needs to work on the freshest image (possibly not yet
      // Approved), not a stale approved copy. See resolveWallLocalImagePath.
      if (mode === 'edit') {
        imagePath = await resolveWallLocalImagePath(wall);
        if (!imagePath) return sendJson(res, 400, { error: `${wall} has no image yet — generate or upload one first` });
      }
      // 'videoedit' works on the wall's finished CLIP. The writer cannot watch
      // a video, so it is shown one frame from a second in - past any first-
      // frame hold, still close enough to the start to show what is in shot.
      if (mode === 'videoedit') {
        const clip = await resolveWallLocalVideoPath(wall);
        if (!clip) return sendJson(res, 400, { error: `${wall} has no finished clip yet — generate its video first` });
        imagePath = path.join(path.dirname(clip), path.basename(clip, path.extname(clip)) + '-frame.png');
        await runFfmpeg(['-y', '-ss', '1', '-i', clip, '-frames:v', '1', imagePath]);
      }

      const imageNote = imagePath
        ? `\n\nThe reference image for this wall is at: ${imagePath}\nUse the Read tool to look at it, and make sure the text accurately reflects what's actually visible there (setting, objects, lighting, style) rather than inventing unrelated content.`
        : '';

      let instruction;
      if (mode === 'video') {
        // The ambient-motion instruction now lives in buildVideoInstruction()
        // so this handler and the batch /api/draft-side-animation endpoint share
        // ONE copy — two drifting copies is how a prompt bot ends up
        // contradicting itself. It is also rig-aware: the brief it gives Claude
        // about what the locked block says is derived from the current rig
        // intent, not hardcoded to a forward push.
        instruction = buildVideoInstruction(wall, currentPrompt, scene, imagePath, await allWallImages());
      } else if (mode === 'videoedit') {
        // Video counterpart of 'edit' below: ONE small change to a finished
        // clip, run through a video-EDITING model. A separate locked note
        // (VIDEO_EDIT_LOCK_NOTE in index.html) already tells the editor to
        // keep every frame's movement and timing, so this only names the one
        // change. It must not mention motion at all - the contract governs
        // that, and a second opinion here is how walls drift apart.
        instruction = `You are refining a SMALL, TARGETED edit instruction for an AI video-editing tool that will modify ONE existing video clip in a synchronized multi-wall composition — remove or add exactly one small thing, for the whole length of the clip, nothing more. A separate fixed instruction (not shown to you) already tells the editor to leave everything else exactly as it is — how the picture moves, its timing, framing, lighting, palette, and every object not mentioned — so do not restate any of that, and do not describe any movement.

The attached image is one frame from the clip. Look at it first.

Current draft edit instruction: ${currentPrompt || `(empty — the user hasn't decided yet. Pick ONE small, plausible object visible in the frame to remove, OR ONE small, unobtrusive object to add that would plausibly belong in this exact setting — nothing that changes the composition, main subject, or mood. State clearly in "notes" that this was your own suggestion, not the user's request.)`}${imageNote}

Write ONE clear, concrete, single-item instruction naming the specific object and, if there is more than one plausible candidate, enough detail to pick out the right one — e.g. "Remove the red sled leaning against the fence, just left of center, for the whole clip." Do not describe the whole scene, do not request lighting/style/mood changes, do not bundle more than one change. Put ONLY that instruction in "improved_prompt", ending on a complete sentence — no preamble, no meta-commentary. If the draft is ambiguous or you made the suggestion yourself, put AT MOST one short sentence in "notes" — leave "notes" empty otherwise. Prioritize finishing "improved_prompt" completely over writing "notes" at all.`;
      } else if (mode === 'edit') {
        // This is the "Refine image" section — a small touch-up pass on a
        // wall's already-almost-right image (remove/add ONE small object),
        // run through an image-EDITING model (Flux Kontext / Nano Banana /
        // similar), not the original scene-generation model. A separate
        // locked sentence (not shown to Claude here, see EDIT_LOCK_NOTE in
        // index.html) already tells the editing model to leave everything
        // else untouched, so this instruction only needs to nail down the
        // ONE change — it must not turn into a scene re-description.
        instruction = `You are refining a SMALL, TARGETED edit instruction for an AI photo-editing tool that will modify ONE existing wall image in a synchronized multi-wall video composition — remove or add exactly one small thing, nothing more. A separate fixed instruction (not shown to you) already tells the editor to leave everything else in the photo exactly as it is — composition, camera framing, lighting, palette, and every object not mentioned — so you do not need to restate any of that.

Look at the attached current image first.

Current draft edit instruction: ${currentPrompt || `(empty — the user hasn't decided yet. Pick ONE small, plausible object already visible in the image to remove, OR ONE small, unobtrusive object to add that would plausibly belong in this exact setting — nothing that changes the composition, main subject, or mood. State clearly in "notes" that this was your own suggestion, not the user's request, so they know they can reject or change it.)`}${imageNote}

Write ONE clear, concrete, single-item instruction naming the specific object and, if the image has more than one plausible candidate, enough detail to pick out the right one — e.g. "Remove the red sled leaning against the fence, just left of center" or "Add a small robin perched on the fence rail, roughly a third of the way from the right edge." Do not describe the whole scene, do not request lighting/style/mood changes, do not bundle more than one change into this instruction. Put ONLY that instruction in "improved_prompt", ending on a complete sentence — no preamble, no meta-commentary. If the draft is ambiguous (e.g. more than one object it could mean) or you made the suggestion yourself, put AT MOST one short sentence in "notes" — leave "notes" empty otherwise. Prioritize finishing "improved_prompt" completely over writing "notes" at all.`;
      } else {
        // IMAGE branch, rebuilt. Two faults it was written to fix:
        //   1. It ignored what the user had typed. Someone writing "make the
        //      left side extension of this image" got back a generic invented
        //      scene, because the instruction treated currentPrompt as a rough
        //      draft to replace rather than a brief to execute.
        //   2. It never really looked at the reference. The extension only
        //      works if the writer reads the actual pixels at the edge that has
        //      to continue, so the description carries real detail forward.
        // It is also side-aware: the locked block for this wall already states
        // which edge meets the centre, and the text must not contradict it.
        const isSide = wall !== 'center';
        const innerEdge = wall === 'left' ? 'RIGHT' : 'LEFT';
        const outerEdge = wall === 'left' ? 'LEFT' : 'RIGHT';
        // The composition mode was being read off the request and then thrown
        // away, so this instruction always described an extension no matter
        // which mode the locked block would actually be built in. The two have
        // to agree: the wall text and the locked rules are concatenated.
        const cMode = ['extension', 'panoramic', 'distinct'].includes(compositionMode)
          ? compositionMode : 'extension';
        const outerWord = outerEdge === 'LEFT' ? 'left' : 'right';
        const sideBriefByMode = {
          extension:
            `This is the ${wall.toUpperCase()} wall, and the mode is EXTENSION — the same world, seen in a `
            + `different direction.

`
            + `THE VIEWER DOES NOT MOVE. One person sits in the middle of the room. The reference image is `
            + `what they see looking STRAIGHT AHEAD. This wall is what that same person, from that same `
            + `seat, sees when they turn their head 90 degrees to the ${outerWord} and look along the side `
            + `of the room. Describe THAT view. It is not a wider crop of the reference, not the reference `
            + `panned sideways, and not the reference's subject shown again from further away.

`
            + `WHERE THINGS SIT. The reference's main subject is straight ahead of the viewer, which from `
            + `here is off past the ${innerEdge} edge of this frame — at most its extreme edge clips in `
            + `there, steeply foreshortened. The frame is filled instead by what runs ALONGSIDE the space: `
            + `the side wall, the side of the crowd or street, the floor or ground running away, whatever `
            + `lines that side. Nearest and largest at the ${outerEdge} edge, receding toward the `
            + `${innerEdge} edge where this wall meets the centre.

`
            + `THE SEAM. At the ${innerEdge} edge, the horizon or eyeline height, the ground plane, the `
            + `light direction and the palette must all continue the reference exactly. Turning your head `
            + `does not change the room.

`
            + `THE HERO STAYS ON THE CENTRE. Whatever the reference is about — a character, figure, `
            + `product, logo, display or landmark — appears once, on the centre wall. Do not describe it, a `
            + `copy of it, a smaller one further away, or another of the same kind added for balance.`,
          panoramic:
            `This is the ${wall.toUpperCase()} wall, and the mode is PANORAMIC — one single very wide image `
            + `sliced into three vertical panels, of which this is the ${outerWord} one. Its ${innerEdge} `
            + `edge must continue seamlessly into the centre image's ${outerEdge} edge: anything crossing `
            + `that boundary is cut off here and picked up exactly where it left off there, same size, same `
            + `angle, same height.\n\n`
            + `THE HERO STAYS ON THE CENTRE. The main subject of the reference belongs to the centre panel `
            + `and appears exactly once across the three. Do not describe it, a copy of it, or another one `
            + `like it on this wall — describe the part of the panorama that surrounds it.`,
          distinct:
            `This is the ${wall.toUpperCase()} wall, and the mode is DISTINCT — a separate, self-contained `
            + `image from a different vantage point within the same setting, sharing the reference's world, `
            + `style, light and palette but not its framing. Do not describe the reference's main subject, `
            + `its focal point or its exact composition; this is its own picture, taken elsewhere in the `
            + `same place.`,
        };
        const sideBrief = isSide
          ? sideBriefByMode[cMode]
          : `This is the CENTRE wall — the anchor. It holds the main subject, and the other two walls `
            + `continue this same place outward on either side.`;

        instruction = `You are writing the subject description for ONE wall of a three-wall immersive display. A separate locked block (which you cannot see) already covers camera framing, perspective, lighting continuity and composition rules — do NOT restate any of that. Your text is added to it.

${sideBrief}

STEP 1 — READ THE REFERENCE IMAGE PROPERLY. Use the Read tool on the attached image and study it closely before writing anything. Assume NOTHING about what kind of image it is — it may be a photograph, a 3D render, anime or cel artwork, flat vector graphics, a painting, a pattern or something abstract, and it may be of any subject at all. Take every answer from the pixels in front of you, never from what this kind of wall "usually" shows. Note, specifically: the medium and rendering style — photographic, drawn, rendered, flat, painterly — and the line weight, outline treatment, level of detail and texture that go with it; the exact setting and what kind of place or space it is, if it is a place at all; whatever the scene is actually built from (that might be buildings and roads, or trees, or water, or sky, or a flat coloured field, or a repeating pattern — describe what is really there); the ground, floor or base plane if one exists; the colour palette and background treatment; the light direction, colour temperature and shadow behaviour; and above all WHAT IS HAPPENING AT THE EDGES of the frame, because that is what has to continue.

STEP 2 — USE WHAT THE USER WROTE. Their text below is an instruction to follow, not a rough draft to discard. If they say "make the left side extension of this image", that is the brief: your job is to write what that extension actually contains, in concrete detail. If they name specific things, those must appear. Only invent detail where they have left it open, and keep every invention consistent with what is actually visible in the reference.

What the user wrote for this wall:
${(currentPrompt || '').trim() || '(nothing written — derive the description from the reference image and the scene note below)'}

Overall scene note (may cover all three walls — use only the part about THIS wall):
${scene || '(none given)'}${imageNote}

STEP 3 — WRITE IT. Describe what is in THIS wall's frame: the specific things that actually continue from the reference — whatever they turned out to be — positioned roughly (near the ${innerEdge} edge / across the middle / toward the ${outerEdge} edge), in the same materials, style, density and light as the reference. State the medium plainly at the start if it is anything other than photographic, so the image model does not default to a photograph: for example "flat 2D anime-style artwork" or "stylised 3D render". Be concrete and specific about what is in the frame, not a mood statement. Do NOT describe camera angle, lens, framing, perspective or "match the reference" — the locked block covers all of it.${isSide ? ' Do NOT include the hero — the main character, figure, product, logo, display or landmark the reference is about — nor a second, smaller or alternative version of it; that belongs to the centre wall alone.' : ''}

Put ONLY that description in "improved_prompt", in full, ending on a complete sentence, no preamble. If something is genuinely ambiguous put AT MOST one short sentence in "notes"; otherwise leave "notes" empty. Finishing "improved_prompt" matters more than writing "notes".`;
      }

      try {
        // Same helper the batch drafting endpoint uses — one invocation, one
        // set of guards (truncation, empty result, structured output).
        //
        // The VIDEO branch runs in typed mode: its answer is the scene half of
        // a JSON contract, and a long free-text field holding a JSON document
        // truncates (one centre wall came back "Expected ',' or '}' ... at
        // position 2882"). A declared shape cannot half-close a brace.
        let botOpts;
        if (mode === 'video') {
          const PRINCIPLES = require('./principles.js');
          const appliedRig = LEARN.applyCalibration(state.calibration, state.rig || RIG.defaultRig());
          const lockedForWall = PRINCIPLES.buildLockedJson(wall, appliedRig);
          botOpts = { schema: VIDEO_SCENE_SCHEMA, assemble: (d) => sceneJsonFromDraft(d, lockedForWall) };
        }
        const r = await runPromptBot(instruction, imagePath, botOpts);
        return sendJson(res, 200, { improvedPrompt: r.prompt, notes: r.notes, costUsd: r.costUsd });
      } catch (err) {
        return sendJson(res, 500, { error: humaniseCliError(err) });
      }
    }

    // What a reset would destroy. Two things the calibrator and the user each
    // care about: generations still running (killing one wastes the credits
    // already spent on it) and finished generations nobody has rated yet
    // (every unrated result is a sample the self-calibration never gets).


    // ---- verify: does the finished set actually perform the applied preset? --
    // The tool could state a rig move and generate under it, then have no idea
    // whether the result obeyed. Measuring each finished wall and comparing it
    // to the move that was applied is the only way "the camera path is nowhere
    // near the reference" becomes a thing the tool says rather than something
    // the user has to notice in Premiere.
    if (req.method === 'POST' && p === '/api/verify-motion') {
      const RIGSPEC = require('./rigspec.js');
      const moveId = RIGSPEC.normalise(state.rig && state.rig.intent);
      const dur = (state.rig && state.rig.durationSec) || 5;
      // The numbers the prompt was actually written with - the speed dial
      // after calibration, and the centre trim. Leaving them out compared
      // every clip against 100% with no trim, whatever the dials said.
      const applied = LEARN.applyCalibration(state.calibration, state.rig || RIG.defaultRig()) || {};
      const out = { move: moveId, durationSec: dur, walls: {}, verdict: 'unknown', notes: [],
                    speedPct: applied.speedPct, centrePct: applied.centrePct };

      for (const w of WALL_IDS) {
        const url = state.walls[w].genVideoUrl;
        if (!url) { out.walls[w] = { error: 'no generated clip on this wall yet' }; continue; }
        let local = null;
        try {
          const ext = path.extname(new URL(url).pathname) || '.mp4';
          local = path.join(UPLOADS_DIR, w + '-verify-' + Date.now() + ext);
          await downloadFile(url, local);
        } catch (e) { out.walls[w] = { error: 'could not download: ' + e.message }; continue; }
        try {
          out.walls[w] = await runVerify(local);
        } catch (e) { out.walls[w] = { error: String(e.message || e).slice(0, 200) }; }
      }

      // Compare against the SPEC the prompt actually carried, term by term.
      // Distinct failures get distinct tests, because they need different
      // fixes and lumping them into one "mismatch" told the operator nothing
      // actionable.
      const cmp = [];
      for (const w of WALL_IDS) {
        const got = out.walls[w];
        if (!got || got.error) continue;
        // The clip was measured at its own length; the spec is stated for the
        // length asked for. Compare TOTALS, which is what transfers between
        // clip lengths - comparing per-second rates is what made the old
        // check call a correct five-second clip "too weak".
        // Prefer the dials this clip was generated under (recorded in the
        // Library since this change); older clips fall back to the current ones.
        const rec = (state.library || []).find(r => r.url === state.walls[w].genVideoUrl) || {};
        const sp = rec.speedPct || applied.speedPct;
        const cp = rec.centrePct || applied.centrePct;
        // GRADE EACH CLIP AGAINST THE MOVE IT WAS MADE UNDER, not against
        // whatever the dropdown says now. This was measured on 2026-09-23: a
        // C_PushOut set was graded against C_PushIn because the preset had been
        // switched back afterwards, and the verdict came out exactly inverted -
        // the two walls that had obeyed were reported "travelling the WRONG
        // WAY" and "zooming the WRONG WAY", and the one wall that really had
        // performed a push in was passed as correct. The Library has recorded
        // the move per clip all along; nothing was reading it.
        const mv = RIGSPEC.normalise(rec.move || moveId);
        const row = RIGSPEC.compare(mv, w, got, sp, cp);
        row.move = mv;
        row.moveFrom = rec.move ? 'generation' : 'current';
        row.dialsFrom = rec.speedPct ? 'generation' : 'current';
        if (w === 'center') out.centrePct = cp || 100;
        cmp.push(row);
      }
      out.comparison = cmp;
      // Say so plainly when the clips on the wall are not the preset that is
      // selected now. Silently grading them against the dropdown is what
      // produced an inverted verdict nobody could argue with.
      const graded = Array.from(new Set(cmp.map(r => r.move))).filter(Boolean);
      if (graded.length) {
        out.gradedAgainst = graded.length === 1 ? graded[0] : graded;
        if (graded.length > 1) {
          out.notes.push('These clips were not all generated under the same preset ('
            + cmp.map(r => r.wall.toUpperCase() + ' = ' + r.move).join(', ')
            + '). Each is graded against its own, but they will not stitch as one move.');
        } else if (graded[0] !== moveId) {
          out.notes.push('The preset selected now is ' + moveId + ', but these clips were generated '
            + 'under ' + graded[0] + '. They are graded against ' + graded[0] + ' - what they were '
            + 'actually asked to do.');
        }
      }
      if (cmp.some(r => r.dialsFrom === 'current')) {
        out.notes.push('Some clips predate dial recording and are compared against the CURRENT speed '
                     + '(' + applied.speedPct + '%) - if the dial has moved since they were made, their '
                     + 'distance figures are off by that ratio. The centre-pace check is a ratio between '
                     + 'walls and is unaffected.');
      }
      // THE ELEMENT EATS THE CAMERA MOVE. Measured 2026-09-23 on the first set
      // generated with a travelling element actually reaching the contract:
      // both side walls collapsed to dx 0.09 and 0.08 against an ask of 0.43,
      // the left wall's background ratio fell to 0.28 (a static plate), and the
      // owls flew across anyway. Given something to animate, the generator
      // animates it and leaves the plate alone. Worth naming, because the
      // obvious reading of "the sides barely moved" is that the speed dial is
      // wrong, and it is not - the same dial moved them before.
      const elOn = !!(state.rig && state.rig.element && state.rig.element.enabled
                      && state.rig.element.subject);
      const sideRows = cmp.filter(r => r.wall !== 'center' && r.dx && r.dx.ratio > 0);
      if (elOn && sideRows.length === 2 && sideRows.every(r => r.dx.ratio < 0.5)) {
        out.notes.push('Both side walls came in under half the asked-for travel while a travelling '
          + 'element was in the contract. Given an object to animate, the generator has repeatedly '
          + 'spent the motion on the object and left the plate nearly still. Test the camera on its '
          + 'own first - remove the element, get the move measuring right, then put it back.');
      }
      out.pace = RIGSPEC.paceMatch(cmp, out.centrePct);
      if (out.pace && !out.pace.matched) out.notes.push(out.pace.note);

      const bad = cmp.filter(c => c.problems.length);
      if (!cmp.length) { out.verdict = 'unknown'; out.notes.push('Nothing measurable yet - generate a set first.'); }
      else if (!bad.length) {
        out.verdict = 'match';
        out.notes.push('All ' + cmp.length + ' measured wall' + (cmp.length === 1 ? '' : 's') + ' perform '
          + (out.gradedAgainst || moveId) + ' within tolerance: direction, distance travelled, scale change and roll all agree '
          + 'with the preset.');
      } else {
        out.verdict = bad.some(c => c.problems.some(t => /WRONG WAY|static plate/.test(t))) ? 'mismatch' : 'off-spec';
        for (const c of bad) out.notes.push(c.wall.toUpperCase() + ': ' + c.problems.join('; ') + '.');
        out.notes.push('Regenerate the walls listed above. What the preset asked for is in the preset '
                     + 'inspector; what was measured is beside each wall.');
      }
      return sendJson(res, 200, out);
    }

    // ---- MOTION LOCK: build the clip's last frame from its first ----------
    // The strongest lever available, and it exists because wording is not one.
    // "The left wall does not move" has been reported three times and measured
    // at +0.015 frame widths against a contract asking for +0.665. Seedance
    // 2.5 accepts start_image AND end_image, so given both, the translation
    // stops being an instruction the model may weigh against its own priors
    // and becomes an interpolation it has to perform.
    if (req.method === 'POST' && p === '/api/build-end-frame') {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      const wall = body.wall;
      if (!WALL_IDS.includes(wall)) return sendJson(res, 400, { error: 'bad wall' });

      const src = await resolveWallLocalImagePath(wall);
      if (!src || !fs.existsSync(src)) {
        return sendJson(res, 400, { error:
          'The ' + wall + ' wall has no approved image yet. The end frame is built FROM that image, '
          + 'so generate or upload it first.' });
      }

      const RIGSPEC = require('./rigspec.js');
      const applied = LEARN.applyCalibration(state.calibration, state.rig || RIG.defaultRig());
      const moveId = RIGSPEC.normalise(applied.intent);
      const sp = RIGSPEC.spec(moveId, wall, applied.durationSec || 5);
      // THE END FRAME IS BUILT FROM THE ROOM'S FIGURES, NOT FROM THE ASK.
      // On the right wall the contract deliberately asks for the reverse of what
      // the room wants, because the generator reverses it (see DELIVERY_SIGN in
      // rigspec.js). Nothing reverses an end frame: it is a real image warped by
      // a real amount and handed over as an interpolation target. Feeding it the
      // inverted ask would warp the plate backwards and break the one lever that
      // does not argue back.
      const lockDx = sp.dxDelivered;
      const lockScaleRaw = sp.scaleDelivered;
      if (Math.abs(lockDx) < 0.01 && Math.abs(lockScaleRaw - 1) < 0.01) {
        return sendJson(res, 400, { error:
          moveId + ' does not move this wall, so there is no end frame to build.' });
      }

      // NOT ON A PURE ZOOM unless asked twice. Measured off the delivered set:
      // the centre wall, given a start and an end frame half the size, held
      // the first frame and then stepped to the last - scale went
      // 1.00, 1.00, 1.00, 0.95, 0.50, 0.49, 0.30 across the clip. A start/end
      // pair is a strong lever for a TRANSLATION and a bad one for a dolly,
      // where the in-between is the whole shot.
      if (Math.abs(lockDx) < 0.05 && !body.force) {
        return sendJson(res, 400, { error:
          'This move is a dolly on the ' + wall + ' wall, not a slide, and locking a dolly to a '
          + 'start/end pair made it hold the first frame and jump to the last. Leave this wall '
          + 'unlocked - its per-second checkpoints already specify the ramp. Send force:true if you '
          + 'want it anyway.' });
      }

      // A clear route back out. The lock changes what gets sent for every
      // later generation on this wall, so it must be visible and reversible -
      // it was neither, and a set went out locked that nobody had asked to
      // lock.


      // Use the SAME scale the contract states, not the raw measurement. A
      // residual under 15% is reported as scale_end 1.0 in the JSON (and the
      // negatives then say "No zoom"), so warping the end frame by 0.91 would
      // hand the generator a target its own instructions forbid.
      const lockScale = Math.abs(lockScaleRaw - 1) >= 0.15 ? lockScaleRaw : 1.0;

      const out = path.join(UPLOADS_DIR, wall + '-endframe-' + Date.now() + '.png');
      let info;
      try {
        const raw = await new Promise((resolve, reject) => {
          const child = spawn(PYTHON_BIN, [path.join(APP_DIR, 'make_end_frame.py'), src, out,
                                           '--dx', String(lockDx), '--scale', String(lockScale)],
                              { stdio: ['ignore', 'pipe', 'pipe'] });
          let o = '', e = '';
          child.stdout.on('data', d => o += d);
          child.stderr.on('data', d => e += d);
          child.on('error', err => reject(new Error('Could not run ' + PYTHON_BIN + ': ' + err.message)));
          child.on('close', c => c === 0 ? resolve(o) : reject(new Error(e.trim() || 'make_end_frame exited ' + c)));
        });
        info = JSON.parse(raw.slice(raw.indexOf('{')));
      } catch (e) {
        return sendJson(res, 500, { error: String(e.message || e).slice(0, 300) });
      }

      state.walls[wall].startFramePath = src;
      state.walls[wall].endFramePath = out;
      saveState();
      return sendJson(res, 200, {
        ok: true, move: moveId, wall: wall,
        startFrame: '/uploads/' + path.basename(src),
        endFrame: '/uploads/' + path.basename(out),
        dxTotal: lockDx, scaleTotal: lockScale,
        revealedBandPx: info.revealed_band_px, revealedAt: info.revealed_at,
        note: 'The revealed band is a streak of the edge colours, not invented content - it carries '
            + 'the floor line, skirting and horizon at their true heights and leaves the detail to '
            + 'the generator, which is exactly what the contract asks for in that band.',
      });
    }

    if (req.method === 'POST' && p === '/api/clear-motion-lock') {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      const walls = Array.isArray(body.walls) ? body.walls : (body.wall ? [body.wall] : WALL_IDS);
      for (const w of walls) {
        if (!WALL_IDS.includes(w)) continue;
        state.walls[w].startFramePath = null;
        state.walls[w].endFramePath = null;
      }
      saveState();
      return sendJson(res, 200, { ok: true, cleared: walls });
    }

    // ---- the preset inspector: exactly what the applied move puts in the
    // prompt, in numbers, so "did apply actually do anything" is answerable
    // without reading the generated prompt.
    if (req.method === 'GET' && p === '/api/preset-spec') {
      const RIGSPEC = require('./rigspec.js');
      const asked = (url.searchParams.get('move') || (state.rig && state.rig.intent) || 'C_PushIn');
      const dur = Number(url.searchParams.get('duration')) || (state.rig && state.rig.durationSec) || 5;
      const moveId = RIGSPEC.normalise(asked);
      const applied = RIGSPEC.normalise(state.rig && state.rig.intent);
      return sendJson(res, 200, {
        asked: asked,
        move: moveId,
        appliedMove: applied,
        isApplied: applied === moveId,
        substituted: RIGSPEC.spec(asked, 'center', dur).substituted,
        durationSec: dur,
        label: RIGSPEC.MOVES[moveId].label,
        refClip: RIGSPEC.MOVES[moveId].refClip,
        refDur: RIGSPEC.MOVES[moveId].refDur,
        safePxPerFrame: RIGSPEC.SAFE_PX_PER_FRAME,
        rows: RIGSPEC.inspector(moveId, dur),
        // Both views. `blocks` is the human-readable spec, `json` is the
        // contract that is actually sent - showing only one of them is how a
        // debug panel ends up agreeing with itself and not with the
        // generation.
        blocks: {
          left: RIGSPEC.numericBlock(moveId, 'left', dur),
          center: RIGSPEC.numericBlock(moveId, 'center', dur),
          right: RIGSPEC.numericBlock(moveId, 'right', dur),
        },
        json: {
          left: require('./principles.js').buildLockedJson('left', Object.assign({}, state.rig, { intent: moveId, durationSec: dur })),
          center: require('./principles.js').buildLockedJson('center', Object.assign({}, state.rig, { intent: moveId, durationSec: dur })),
          right: require('./principles.js').buildLockedJson('right', Object.assign({}, state.rig, { intent: moveId, durationSec: dur })),
        },
      });
    }

    // The travelling element's reference picture. One per rig, not per wall:
    // it is one object making one journey, and the whole point is that all
    // three walls show the SAME object rather than three inventions of the
    // same sentence.
    if (req.method === 'POST' && p === '/api/element-ref') {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      state.rig = state.rig || RIG.defaultRig();
      state.rig.element = state.rig.element || {};
      if (body.clear) {
        state.rig.element.refPath = null;
      } else {
        const ext = path.extname(body.filename || '') || '.png';
        const dest = path.join(UPLOADS_DIR, `element-${Date.now()}${ext}`);
        fs.writeFileSync(dest, Buffer.from(body.dataBase64, 'base64'));
        state.rig.element.refPath = dest;
      }
      saveState();
      return sendJson(res, 200, { ok: true, rig: state.rig });
    }

    if (req.method === 'GET' && p === '/api/library') {
      return sendJson(res, 200, { library: state.library || [], max: LIBRARY_MAX });
    }

    // REBUILD THE LIBRARY FROM THE ACCOUNT.
    //
    // state.library only started being written when recordInLibrary was added,
    // so every generation made before that is missing from the Library tab and
    // the tab reads as broken when it is merely empty. README section 10 says
    // the record can be lost but the generations cannot - this is that recovery
    // path, wired up: `generate list` returns the jobs, and the wall and the
    // move are parsed back out of each job's own prompt.
    //
    // It only ADDS. recordInLibrary dedupes on url, so re-running is safe and
    // nothing already in the library (including ratings) is touched.
    if (req.method === 'POST' && p === '/api/library-rebuild') {
      try {
        // 100 is the CLI's hard cap: --size 200 comes back
        // "query.size: Input should be less than or equal to 100".
        const raw = await runCli(HIGGSFIELD_BIN, ['generate', 'list', '--size', '100', '--json']);
        const parsedList = JSON.parse(raw);
        const jobs = Array.isArray(parsedList) ? parsedList
                   : (parsedList.items || parsedList.data || []);
        const VIDEO_JOB = /seedance|motion|video|kling|minimax|veo|wan/i;
        let added = 0, skipped = 0;
        // Oldest first so that unshifting leaves the newest at index 0.
        for (const job of jobs.slice().reverse()) {
          const url = job.result_url || jobResultUrl(job);
          if (!url || job.status !== 'completed') { skipped++; continue; }
          const prm = job.params || {};
          const text = String(prm.prompt || '');
          const wall = /\bLEFT WALL\b|"wall"\s*:\s*"left"|\/ LEFT wall/i.test(text) ? 'left'
                     : /\bRIGHT WALL\b|"wall"\s*:\s*"right"|\/ RIGHT wall/i.test(text) ? 'right'
                     : /\bCENTRE WALL\b|\bCENTER WALL\b|"wall"\s*:\s*"center"|\/ CENTER wall/i.test(text) ? 'center'
                     : null;
          const mv = text.match(/C_(?:PushIn|PushOut|TrackLeft|TrackRight|Hold)/);
          const kind = VIDEO_JOB.test(String(job.job_type || prm.model || '')) ? 'video' : 'image';
          // Already-present rows are not skipped outright: a row recorded
          // before this endpoint existed (or by an earlier run of it) has no
          // prompt, and the prompt is the whole point of a thumbs-up. Fill in
          // what is missing without touching anything already set - ratings
          // above all.
          const existing = (state.library || []).find(r => r.url === url);
          if (existing) {
            let touched = false;
            if (!existing.prompt && prm.prompt) {
              existing.prompt = String(prm.prompt).slice(0, HISTORY_PROMPT_MAX); touched = true;
            }
            if (!existing.wall && wall) { existing.wall = wall; touched = true; }
            if (!existing.move && kind === 'video' && mv) { existing.move = mv[0]; touched = true; }
            if (touched) added++; else skipped++;
            continue;
          }
          if (recordInLibrary(state, {
            at: job.created_at || new Date().toISOString(),
            wall, kind, url,
            model: job.job_type || prm.model || null,
            move: kind === 'video' && mv ? mv[0] : null,
            durationSec: prm.duration || null,
            resolution: prm.resolution || null,
            scene: '',
            // The prompt that produced it. This is what makes a thumbs-up on a
            // recovered generation worth anything to the WRITER rather than
            // only to the tally: likedExemplar needs prompt text, and without
            // this a liked recovered clip could never become an exemplar.
            // Capped at the same 2000 chars pruneHistory allows.
            prompt: String(prm.prompt || '').slice(0, HISTORY_PROMPT_MAX),
            note: 'recovered from the Higgsfield account',
          })) added++; else skipped++;
        }
        saveState();
        return sendJson(res, 200, {
          added, skipped, total: (state.library || []).length,
          summary: added
            ? `Recovered ${added} generation${added === 1 ? '' : 's'} from your Higgsfield account.`
            : 'Nothing new to recover — the library already has everything the account returned.',
        });
      } catch (e) {
        return sendJson(res, 500, { error: 'Could not read the account: ' + String(e.message || e).slice(0, 300) });
      }
    }

    // Drop one row. The media itself lives on Higgsfield; this only forgets
    // the pointer, so it is safe and is not a delete of anyone's work.
    // Ratings live on the library row as well as on the version record: the
    // version is working state and gets pruned, the library is the permanent
    // record, and a thumbs-up is the most useful thing to still have in six
    // sessions' time.
    if (req.method === 'POST' && p === '/api/library-rate') {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      const row = (state.library || []).find(r => r.url === body.url);
      if (!row) return sendJson(res, 404, { error: 'no library row for that url' });
      row.rating = (row.rating === body.rating) ? null : body.rating;   // click again to clear
      // Keep the version record in step where one exists, so the calibrator
      // and the Statistics tally see the same verdict.
      let linked = 0;
      for (const w of WALL_IDS) {
        for (const v of (state.history[w] || [])) {
          if (v.genVideoUrl === body.url || v.genImageUrl === body.url) {
            v.rating = row.rating;
            v.ratedAt = new Date().toISOString();
            linked++;
          }
        }
      }
      // NO VERSION MEANS THE RATING GOES NOWHERE. Everything the calibrator
      // reads - likedExemplar, ratingTally, recordSample's meta.rating - comes
      // out of state.history, never out of state.library. A row recovered from
      // the account has no version record behind it, so rating it used to set a
      // flag on a row nobody reads: the button lit up and the calibrator never
      // heard about it. Mint the missing version from the row itself.
      if (!linked && row.rating && row.wall && WALL_IDS.includes(row.wall)) {
        LEARN.pushVersion(state.history, row.wall, 'rated', {
          at: row.at || new Date().toISOString(),
          sceneKey: state.centreRefHash || null,
          fromLibrary: true,
          move: row.move || null,
          model: row.model || null,
          // Carry the prompt across under the field likedExemplar reads, so a
          // liked recovered clip actually teaches the writer something.
          videoPrompt: row.kind === 'video' ? (row.prompt || '') : '',
          imagePrompt: row.kind === 'image' ? (row.prompt || '') : '',
          genVideoUrl: row.kind === 'video' ? row.url : null,
          genImageUrl: row.kind === 'image' ? row.url : null,
          rating: row.rating,
          ratedAt: new Date().toISOString(),
        });
        linked = 1;
      }
      saveState();
      return sendJson(res, 200, { ok: true, rating: row.rating, linked,
                                  tally: LEARN.ratingTally(state.history) });
    }

    if (req.method === 'POST' && p === '/api/library-forget') {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      const before = (state.library || []).length;
      state.library = (state.library || []).filter(r => r.url !== body.url);
      saveState();
      return sendJson(res, 200, { removed: before - state.library.length, library: state.library });
    }

    // ---- statistics: what the tool has learned -------------------------------
    if (req.method === 'GET' && p === '/api/stats') {
      const RIGMOVES = require('./rigmoves.js');
      const tally = LEARN.ratingTally(state.history);
      const byWall = {};
      let up = 0, down = 0, unrated = 0, versions = 0;
      WALL_IDS.forEach(w => {
        const list = state.history[w] || [];
        const gen = list.filter(v => v.genImageUrl || v.genVideoUrl);
        const u = (tally[w] || {}).up || 0;
        const d = (tally[w] || {}).down || 0;
        const n = gen.filter(v => !v.rating).length;
        byWall[w] = { up: u, down: d, unrated: n };
        up += u; down += d; unrated += n; versions += list.length;
      });
      const cal = state.calibration || LEARN.emptyCalibration();
      return sendJson(res, 200, {
        ratings: { total: up + down, up, down, unrated, byWall },
        calibration: {
          enabled: !!cal.enabled,
          sinceLast: cal.generations || 0,
          every: 10,
          due: !!(cal.enabled && (cal.generations || 0) >= 10),
          samples: (cal.samples || []).length,
          totalGenerations: cal.totalGenerations || 0,
          speedMultiplier: cal.speedMultiplier,
          sideBias: cal.sideBias,
          lastCalibratedAt: cal.lastCalibratedAt || null,
        },
        history: { versions, walls: WALL_IDS.length },
        moves: RIGMOVES.ids().map(id => {
          const m = RIGMOVES.MOVES[id].measured.CENTER || {};
          return { id, family: RIGMOVES.MOVES[id].family,
                   vx: m.vx || 0, div_x: m.div_x || 0, spread: m.spread || 0 };
        }),
        decodes: state.decodeLog || [],
      });
    }

    // ---- knowledge file: the portable form of everything above ---------------
    // Ratings and calibration are the only things in this tool that took real
    // time to accumulate, and they were trapped in one person's state.json.
    // Export writes them to a named file; import merges someone else's in, so a
    // second machine starts from what the first already worked out.
    if (req.method === 'POST' && p === '/api/knowledge/export') {
      const KDIR = path.join(APP_DIR, 'knowledge');
      if (!fs.existsSync(KDIR)) fs.mkdirSync(KDIR, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const dest = path.join(KDIR, `tri-wall-knowledge-${stamp}.json`);
      const payload = {
        kind: 'tri-wall-knowledge',
        version: 1,
        exportedAt: new Date().toISOString(),
        // The rig library travels too: a teammate who has not recorded their own
        // reference clips still gets a decoder that recognises the moves.
        rigLibrary: (() => {
          try { return JSON.parse(fs.readFileSync(path.join(APP_DIR, 'rig_library.json'), 'utf8')); }
          catch (e) { return null; }
        })(),
        history: state.history,
        calibration: state.calibration,
        decodeLog: state.decodeLog || [],
      };
      fs.writeFileSync(dest, JSON.stringify(payload, null, 2));
      const tally = LEARN.ratingTally(state.history);
      const rated = WALL_IDS.reduce((a, w) => a + ((tally[w] || {}).up || 0) + ((tally[w] || {}).down || 0), 0);
      return sendJson(res, 200, { path: dest,
        summary: `${rated} rated generations, ${(state.calibration && state.calibration.samples || []).length} measured sets` });
    }

    if (req.method === 'POST' && p === '/api/knowledge/import') {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      if (!body || body.kind !== 'tri-wall-knowledge') {
        return sendJson(res, 400, { error: 'That is not a Tri-Wall knowledge file.' });
      }
      // MERGE, never replace: importing a teammate's file must not delete the
      // ratings this machine has already earned. Versions are keyed by id, so a
      // shared history can be folded in without duplicating anything.
      let added = 0;
      WALL_IDS.forEach(w => {
        const mine = state.history[w] || (state.history[w] = []);
        const seen = new Set(mine.map(v => v.id));
        (((body.history || {})[w]) || []).forEach(v => {
          if (v && v.id && !seen.has(v.id)) { mine.push(v); seen.add(v.id); added++; }
        });
        mine.sort((a, b) => String(b.at).localeCompare(String(a.at)));
      });
      if (body.calibration && Array.isArray(body.calibration.samples)) {
        const cal = state.calibration || (state.calibration = LEARN.emptyCalibration());
        cal.samples = (cal.samples || []).concat(body.calibration.samples).slice(-30);
        cal.totalGenerations = (cal.totalGenerations || 0) + (body.calibration.totalGenerations || 0);
      }
      if (Array.isArray(body.decodeLog)) {
        state.decodeLog = (state.decodeLog || []).concat(body.decodeLog).slice(-100);
      }
      saveState();
      return sendJson(res, 200, { summary: `Imported — ${added} generation records merged in. `
        + `Nothing of yours was replaced.` });
    }

    if (req.method === 'GET' && p === '/api/pending') {
      const running = [];
      WALL_IDS.forEach(w => {
        const st = state.walls[w];
        if (st.genImageStatus === 'running') running.push({ wall: w, kind: 'image' });
        if (st.genVideoStatus === 'running') running.push({ wall: w, kind: 'video' });
      });
      // Anything with an actual result and no verdict yet. Prompt-only and
      // pre-generation snapshots are not gradeable, so they are not counted.
      const unrated = [];
      const rated = new Set();
      WALL_IDS.forEach(w => (state.history[w] || []).forEach(v => {
        if (v.rating) { if (v.genImageUrl) rated.add(v.genImageUrl); if (v.genVideoUrl) rated.add(v.genVideoUrl); }
      }));
      // The result a wall is showing RIGHT NOW is not in history yet — history
      // only receives it when the next generation displaces it. That is exactly
      // the generation a user is most likely to want to rate before wiping the
      // scene, so it is listed first, with a null id that /api/rate turns into
      // a durable snapshot at rating time.
      WALL_IDS.forEach(w => {
        const st = state.walls[w];
        const url = st.genImageUrl || st.genVideoUrl;
        if (!url || rated.has(url)) return;
        unrated.push({ wall: w, id: null, kind: st.genImageUrl ? 'image' : 'video',
                       at: new Date().toISOString(), url,
                       isVideo: !st.genImageUrl && !!st.genVideoUrl, current: true });
      });
      WALL_IDS.forEach(w => {
        (state.history[w] || []).forEach(v => {
          if (v.rating) return;
          if (!v.genImageUrl && !v.genVideoUrl) return;
          const url = v.genImageUrl || v.genVideoUrl;
          if (rated.has(url) || unrated.some(u => u.url === url)) return;
          unrated.push({ wall: w, id: v.id, kind: v.kind, at: v.at, url,
                         isVideo: !!v.genVideoUrl && !v.genImageUrl });
        });
      });
      // Newest first, and capped: a reset dialog listing eighty thumbnails is
      // not a rating prompt, it is a reason to click "skip".
      unrated.sort((a, b) => String(b.at).localeCompare(String(a.at)));
      const capped = unrated.slice(0, 12);
      return sendJson(res, 200, { running, unrated: capped, unratedTotal: unrated.length,
                                  tally: LEARN.ratingTally(state.history) });
    }

    if (req.method === 'POST' && p === '/api/reset') {
      // Wipes the scene, all prompts, all reference images and all image/video
      // results back to a blank slate. Uploaded/generated files on disk are
      // left alone (just unreferenced) — nothing is deleted.
      //
      // Two things deliberately SURVIVE a reset, because they are not part of
      // "this picture" and are the whole point of the self-calibration feature:
      // the rating history and the calibration it derives. Wiping them on every
      // new scene would mean the tool never accumulates the 10 generations it
      // needs to re-learn. Everything scene-shaped goes, including the centre
      // reference hash and the measured grade lock.
      const keptHistory = state.history;
      const keptCalibration = state.calibration;
      state = defaultState();
      state.history = keptHistory;
      state.calibration = keptCalibration;
      state.centreRefHash = null;
      saveState();
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/clear-image') {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      const { wall, field } = body;
      if (!WALL_IDS.includes(wall)) return sendJson(res, 400, { error: 'bad wall' });
      // A frame field's remove button clears just that one field — it must
      // NOT touch the wall's main image state (genImageUrl/approvedImagePath
      // etc.), which is a separate, unrelated input.
      if (field === 'startFramePath' || field === 'endFramePath') {
        state.walls[wall][field] = null;
        saveState();
        return sendJson(res, 200, { ok: true });
      }
      Object.assign(state.walls[wall], {
        genImageUrl: null, genImageStatus: null,
        uploadedImagePath: null, approvedImagePath: null,
      });
      saveState();
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/approve') {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      const { wall } = body;
      if (!WALL_IDS.includes(wall)) return sendJson(res, 400, { error: 'bad wall' });
      const url = state.walls[wall].genImageUrl;
      if (!url) return sendJson(res, 400, { error: 'no generated image to approve yet' });
      // The generated image is a remote Higgsfield URL — download it once so
      // it can be passed to the CLI as a local path for later generate calls.
      const ext = path.extname(new URL(url).pathname) || '.jpg';
      const dest = path.join(UPLOADS_DIR, `${wall}-approved-${Date.now()}${ext}`);
      await downloadFile(url, dest);
      let clearedScene = false;
      if (wall === 'center' && centreReferenceChanged(dest)) {
        // Approving a NEW centre generation retires the previous picture's
        // sides, for the same reason an upload does — but the centre's own
        // description is what produced this image, so it stays.
        invalidateSidesForNewCentre();
        clearedScene = true;
      }
      state.walls[wall].approvedImagePath = dest;
      saveState();
      if (wall === 'center') { refreshCentreGradeRef().catch(() => {}); }
      return sendJson(res, 200, { path: dest, clearedScene });
    }

    // ---- Refine image: small, targeted remove/add-one-thing edits ----
    //
    // Per explicit user request: images approved out of the main Reference
    // Images generation are "almost perfect" except for one stray or
    // missing small object — rather than regenerating the whole wall from
    // scratch (which redraws everything and loses the parts that were
    // already right), this runs the wall's CURRENT image through an
    // image-EDITING model (Flux Kontext / Nano Banana / similar — any
    // catalog model with an `image_references` + `prompt` shape works,
    // selected via #editModelSelect, never hardcoded to one choice) with a
    // small instruction naming just the one thing to remove or add.
    //
    // Reuses genImageUrl/genImageStatus — the SAME fields the main
    // Reference Images generation writes — rather than a separate result
    // slot: an edit's output IS this wall's new generated image, exactly
    // like a regeneration would be, so it shows up in the Reference Images
    // card too and is ready for the existing Approve button (on either
    // card) without any new state shape. Chains naturally: editing twice in
    // a row edits the first edit's result, since resolveWallLocalImagePath
    // always re-downloads the LATEST genImageUrl.
    if (req.method === 'POST' && p === '/api/edit-image') {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      const { wall, jst, prompt, params } = body;
      if (!WALL_IDS.includes(wall)) return sendJson(res, 400, { error: 'bad wall' });

      const imagePath = await resolveWallLocalImagePath(wall);
      if (!imagePath) return sendJson(res, 400, { error: `${wall} has no image yet to edit — generate or upload one first` });

      // An edit overwrites genImageUrl in place, so the pre-edit image is only
      // recoverable if it is snapshotted here first.
      LEARN.snapshotWall(state.history, wall, state.walls[wall], 'pre-edit', {
        sceneKey: state.centreRefHash,
        model: jst, promptSubmitted: prompt,
      });

      const args = ['generate', 'create', jst, '--prompt', cliPromptArg(prompt)];
      Object.entries(params || {}).forEach(([k, v]) => {
        if (v === '' || v === null || v === undefined) return;
        args.push(`--${k}`, String(v));
      });
      args.push('--image', imagePath, '--json');

      state.walls[wall].genImageStatus = 'running';
      saveState();

      try {
        const createRaw = await runCli(HIGGSFIELD_BIN, args);
        const createdParsed = JSON.parse(createRaw);
        const createdItem = Array.isArray(createdParsed) ? createdParsed[0] : createdParsed;
        const jobId = typeof createdItem === 'string' ? createdItem : createdItem?.id;
        if (!jobId) throw new Error(`Higgsfield didn't return a job id: ${createRaw.slice(0, 300)}`);
        const createdStatus = typeof createdItem === 'object' ? createdItem?.status : undefined;

        let resultUrl = jobResultUrl(createdItem), job = createdItem, timedOut = false;
        if (!TERMINAL_STATUSES.includes(createdStatus)) {
          ({ url: resultUrl, job, timedOut } = await pollJobUntilDone(jobId, 12 * 60 * 1000));
        }

        if (!resultUrl && timedOut) {
          pollJobInBackground(wall, 'image', jobId, { model: jst, note: 'refinement edit' });
          return sendJson(res, 200, { url: null, jobId, timedOut: true,
            note: 'Still rendering on Higgsfield past the wait budget — status will update automatically once it finishes.' });
        }

        state.walls[wall].genImageUrl = resultUrl;
        state.walls[wall].genImageStatus = resultUrl ? 'completed' : 'failed';
        if (resultUrl) {
          recordInLibrary(state, {
            at: new Date().toISOString(), wall, kind: 'image', url: resultUrl,
            model: jst, move: null, scene: (state.scene || '').slice(0, 120), note: 'refinement edit',
          });
        }
        saveState();
        // No moveUsed here: that const lives in /api/generate's scope, and
        // naming it threw a ReferenceError AFTER the new URL was saved - the
        // catch below then marked the wall 'failed' and the page never
        // redrew, so every successful edit looked like it had not happened.
        return sendJson(res, 200, { url: resultUrl, job });
      } catch (err) {
        state.walls[wall].genImageStatus = 'failed';
        saveState();
        return sendJson(res, 500, { error: err.message });
      }
    }

    // ---- Refine video: the same one-small-change edit, on a finished clip ----
    //
    // Mirrors /api/edit-image. The wall's CURRENT clip goes to a video-EDITING
    // model (#videoEditModelSelect - kling_video_edit, flux_3_video_edit, or
    // whatever the catalogue offers with a `video_references` input) and the
    // result replaces genVideoUrl in place, so the Video card, Play all and
    // Check against preset all see it with no new state shape. Chains the same
    // way: a second edit edits the first one's result.
    if (req.method === 'POST' && p === '/api/edit-video') {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      const { wall, jst, prompt, params } = body;
      if (!WALL_IDS.includes(wall)) return sendJson(res, 400, { error: 'bad wall' });

      const clipPath = await resolveWallLocalVideoPath(wall);
      if (!clipPath) return sendJson(res, 400, { error: `${wall} has no finished clip yet to edit — generate its video first` });

      // The pre-edit clip is only recoverable if it is snapshotted first.
      LEARN.snapshotWall(state.history, wall, state.walls[wall], 'pre-video-edit', {
        sceneKey: state.centreRefHash,
        model: jst, promptSubmitted: prompt,
      });
      // An edit keeps the source clip's motion, so it keeps its preset label.
      const src = (state.library || []).find(r => r.url === state.walls[wall].genVideoUrl);

      const args = ['generate', 'create', jst, '--prompt', cliPromptArg(prompt)];
      Object.entries(params || {}).forEach(([k, v]) => {
        if (v === '' || v === null || v === undefined) return;
        args.push(`--${k}`, String(v));
      });
      args.push('--video-references', clipPath, '--json');

      state.walls[wall].genVideoStatus = 'running';
      saveState();

      try {
        const createRaw = await runCli(HIGGSFIELD_BIN, args);
        const createdParsed = JSON.parse(createRaw);
        const createdItem = Array.isArray(createdParsed) ? createdParsed[0] : createdParsed;
        const jobId = typeof createdItem === 'string' ? createdItem : createdItem?.id;
        if (!jobId) throw new Error(`Higgsfield didn't return a job id: ${createRaw.slice(0, 300)}`);
        const createdStatus = typeof createdItem === 'object' ? createdItem?.status : undefined;

        let resultUrl = jobResultUrl(createdItem), job = createdItem, timedOut = false;
        if (!TERMINAL_STATUSES.includes(createdStatus)) {
          ({ url: resultUrl, job, timedOut } = await pollJobUntilDone(jobId, 25 * 60 * 1000));
        }

        if (!resultUrl && timedOut) {
          pollJobInBackground(wall, 'video', jobId, {
            model: jst, move: src ? src.move : null, note: 'refinement edit',
            speedPct: src ? src.speedPct : null, centrePct: src ? src.centrePct : null,
            durationSec: src ? src.durationSec : null, resolution: src ? src.resolution : null,
          });
          return sendJson(res, 200, { url: null, jobId, timedOut: true,
            note: 'Still rendering on Higgsfield past the wait budget — this page will pick it up automatically once it finishes.' });
        }

        state.walls[wall].genVideoUrl = resultUrl;
        state.walls[wall].genVideoStatus = resultUrl ? 'completed' : 'failed';
        if (resultUrl) {
          recordInLibrary(state, {
            at: new Date().toISOString(), wall, kind: 'video', url: resultUrl,
            model: jst, move: src ? src.move : null,
            speedPct: src ? src.speedPct : null, centrePct: src ? src.centrePct : null,
            durationSec: src ? src.durationSec : null, resolution: src ? src.resolution : null,
            scene: (state.scene || '').slice(0, 120), note: 'refinement edit',
          });
        }
        saveState();
        return sendJson(res, 200, { url: resultUrl, job, moveUsed: src ? src.move : null });
      } catch (err) {
        state.walls[wall].genVideoStatus = 'failed';
        saveState();
        return sendJson(res, 500, { error: err.message });
      }
    }

    // ---- Genjutsu speed/path fix: covered in detail below ----
    //
    // Real problem this solves: LEFT and RIGHT are two independent AI video
    // generations. Even with byte-identical fixed rules (same locked
    // wording, same numeric km/h speed — see buildMovingMovementRule),
    // nothing stops one from actually rendering faster/slower or with a
    // subtly different path than the other, since each job is sampled
    // independently. CENTER's forward dolly reportedly doesn't suffer this
    // (user's own observation — "almost always works"), so this only
    // exists for LEFT/RIGHT.
    //
    // The fix: Genjutsu (hf_mult_motion_control) transfers motion from a
    // reference VIDEO onto a reference IMAGE (see app's SKILL.md and the
    // handoff docs for the fuller writeup of how this model behaves — in
    // short: minimal/content-only prompts work far better than describing
    // the motion in words once a reference video is doing that job).
    //
    // The wrinkle the user identified themselves: LEFT trucks right and
    // RIGHT trucks left — genuine mirror-opposite directions by design (see
    // buildMovingMovementRule). Feed LEFT's video straight into Genjutsu as
    // the motion reference for fixing RIGHT, and Genjutsu transfers LEFT's
    // literal motion — including its rightward direction — onto RIGHT's
    // new clip. Wrong axis, same class of bug as everything in the video
    // camera-movement saga.
    //
    // The fix for the fix: horizontally mirror (ffmpeg hflip) the
    // reference wall's video before handing it to Genjutsu. A clip of
    // "camera trucks right at speed X" flipped left-right becomes, frame
    // for frame, "camera trucks left at speed X" — identical pacing and
    // parallax magnitude, opposite apparent direction. Since LEFT and RIGHT
    // are already exact mirror-opposite motions by construction, mirroring
    // is always the right operation for this pair — no branching needed on
    // which wall is source vs target.
    //
    // Known real constraint, surfaced to the client rather than hidden:
    // Genjutsu's `resolution` param caps at 1080p (no 4K option in its
    // schema) — a fixed result here will need a separate upscale pass
    // (Higgsfield has topaz_video/video_upscale jobs) before it matches a
    // 4K final render. Not handled by this endpoint; flagged in the
    // response instead.
    if (req.method === 'POST' && p === '/api/genjutsu-fix') {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      const { goodWall } = body;
      if (goodWall !== 'left' && goodWall !== 'right') {
        return sendJson(res, 400, { error: 'goodWall must be "left" or "right"' });
      }
      const badWall = goodWall === 'left' ? 'right' : 'left';

      const goodVideoUrl = state.walls[goodWall].genVideoUrl;
      if (!goodVideoUrl) return sendJson(res, 400, { error: `${goodWall} has no generated video to use as a reference yet` });
      const badImagePath = state.walls[badWall].approvedImagePath || state.walls[badWall].uploadedImagePath;
      if (!badImagePath) return sendJson(res, 400, { error: `${badWall} has no reference image set yet — Genjutsu needs one to rebuild the scene from` });

      state.walls[badWall].genVideoStatus = 'running';
      saveState();

      try {
        // 1. Download the good wall's video locally — ffmpeg needs a local
        //    file, and Higgsfield's URLs are remote CDN links.
        const rawDest = path.join(UPLOADS_DIR, `${goodWall}-genjutsu-src-${Date.now()}.mp4`);
        await downloadFile(goodVideoUrl, rawDest);

        // 2. Mirror it — this is the actual fix for the wrong-direction
        //    problem described above.
        const mirroredDest = path.join(UPLOADS_DIR, `${goodWall}-genjutsu-mirrored-${Date.now()}.mp4`);
        await runFfmpeg(['-y', '-i', rawDest, '-vf', 'hflip', '-c:a', 'copy', mirroredDest]);

        // 3. Submit to Genjutsu: bad wall's own image (content) + mirrored
        //    good-wall video (motion). Prompt is deliberately minimal — the
        //    bad wall's own subject description if it has one, nothing
        //    about camera movement — per the "less prompt text wins" result
        //    from earlier testing with this same model.
        const prompt = (state.walls[badWall].imagePrompt || '').trim();
        const args = ['generate', 'create', 'hf_mult_motion_control',
          '--image-references', badImagePath,
          '--video-references', mirroredDest,
          '--resolution', '1080p', '--json'];
        if (prompt) args.push('--prompt', cliPromptArg(prompt));

        const createRaw = await runCli(HIGGSFIELD_BIN, args);
        const createdParsed = JSON.parse(createRaw);
        const createdItem = Array.isArray(createdParsed) ? createdParsed[0] : createdParsed;
        const jobId = typeof createdItem === 'string' ? createdItem : createdItem?.id;
        if (!jobId) throw new Error(`Higgsfield didn't return a job id: ${createRaw.slice(0, 300)}`);
        const createdStatus = typeof createdItem === 'object' ? createdItem?.status : undefined;

        let resultUrl = jobResultUrl(createdItem), job = createdItem, timedOut = false;
        if (!TERMINAL_STATUSES.includes(createdStatus)) {
          ({ url: resultUrl, job, timedOut } = await pollJobUntilDone(jobId, 25 * 60 * 1000));
        }

        if (!resultUrl && timedOut) {
          pollJobInBackground(badWall, 'video', jobId);
          return sendJson(res, 200, { url: null, jobId, timedOut: true,
            note: 'Still rendering on Higgsfield past the wait budget — status will update automatically once it finishes.' });
        }

        state.walls[badWall].genVideoUrl = resultUrl;
        state.walls[badWall].genVideoStatus = resultUrl ? 'completed' : 'failed';
        saveState();
        return sendJson(res, 200, {
          url: resultUrl, job, goodWall, badWall,
          note: resultUrl ? `Fixed at 1080p (Genjutsu's cap) — this is below your other walls' 4K if you're rendering final at 4K. Upscale separately if you need it to match.` : undefined,
        });
      } catch (err) {
        state.walls[badWall].genVideoStatus = 'failed';
        saveState();
        return sendJson(res, 500, { error: err.message });
      }
    }

    // ---- connections: is this machine set up, and is this person signed in? ----
    if (req.method === 'GET' && p === '/api/preflight') {
      // Re-resolve on every check: the CLI may have been installed since the
      // server started, either by the Install button or in a terminal.
      refreshHiggsfieldBinary();
      const data = await PRE.preflight({
        higgsfield: HIGGSFIELD_BIN, claude: 'claude', python: PYTHON_BIN, ffmpeg: FFMPEG_BIN,
        connect: HIGGSFIELD_RESOLVED ? CONNECT : null,
      });
      data.higgsfieldBinary = HIGGSFIELD_RESOLVED
        ? { path: HIGGSFIELD_RESOLVED.bin, source: HIGGSFIELD_RESOLVED.source, warning: HIGGSFIELD_RESOLVED.warning || null }
        : null;
      data.npmGlobalPrefix = CONNECT.npmGlobalPrefix();
      return sendJson(res, 200, data);
    }

    // Install the Higgsfield CLI without making anyone open a terminal.
    if (req.method === 'POST' && p === '/api/install-cli') {
      const r = await CONNECT.installHiggsfield();
      refreshHiggsfieldBinary();
      return sendJson(res, r.ok ? 200 : 500, {
        ok: r.ok, error: r.error,
        resolved: HIGGSFIELD_RESOLVED,
        log: (r.log || '').slice(-1500),
      });
    }

    // Billing workspace. Undocumented in the handoff, mandatory in practice:
    // with none selected every Higgsfield call fails with "No workspace
    // selected", even when signed in. On a team it decides whose credits pay.
    if (req.method === 'GET' && p === '/api/workspaces') {
      if (!HIGGSFIELD_RESOLVED) return sendJson(res, 400, { error: 'Higgsfield CLI not installed.' });
      return sendJson(res, 200, {
        current: CONNECT.workspaceStatus(HIGGSFIELD_BIN),
        available: CONNECT.listWorkspaces(HIGGSFIELD_BIN),
      });
    }
    if (req.method === 'POST' && p === '/api/workspace') {
      if (!HIGGSFIELD_RESOLVED) return sendJson(res, 400, { error: 'Higgsfield CLI not installed.' });
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      const r = body.clear ? CONNECT.unsetWorkspace(HIGGSFIELD_BIN)
                           : CONNECT.setWorkspace(HIGGSFIELD_BIN, body.id);
      return sendJson(res, r.ok ? 200 : 500, r);
    }

    // Sign out on this machine — so a shared workstation can switch accounts.
    if (req.method === 'POST' && p === '/api/auth/logout') {
      if (!HIGGSFIELD_RESOLVED) return sendJson(res, 400, { error: 'Higgsfield CLI not installed.' });
      return sendJson(res, 200, CONNECT.authLogout(HIGGSFIELD_BIN));
    }

    // One real Claude call, on demand (~$0.06) — the only way to truly prove
    // sign-in. Deliberately NOT part of the automatic preflight.
    if (req.method === 'POST' && p === '/api/auth/test-claude') {
      const r = await PRE.testClaude('claude');
      return sendJson(res, 200, r);
    }

    // Hands sign-in to the vendor's own CLI. Higgsfield runs in-process and
    // goes straight to the browser (see beginHiggsfieldLogin); `claude` is an
    // interactive REPL, so it still needs a terminal of its own.
    //
    // This app never takes a password, key or token in any field, and never
    // reads one — the CLI writes its own session file under the user's home.
    if (req.method === 'POST' && p === '/api/auth/login') {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      const which = body.which === 'claude' ? 'claude' : 'higgsfield';
      if (which === 'higgsfield') {
        const st = beginHiggsfieldLogin();
        return sendJson(res, 200, { ok: true, inBrowser: true, status: st.status,
                                    url: st.url, note: st.message });
      }
      const r = PRE.openLoginTerminal(which, { higgsfield: HIGGSFIELD_BIN });
      return sendJson(res, r.ok ? 200 : 500, r);
    }

    // Polled by the page while the browser tab is open.
    if (req.method === 'GET' && p === '/api/auth/login-status') {
      const st = hfLogin || { status: 'idle', message: 'No sign-in in progress.' };
      return sendJson(res, 200, {
        status: st.status, url: st.url || null, note: st.message || '',
        account: st.account || null, workspace: st.workspace || null,
      });
    }

    // ---- rig spec: one camera intent, all three walls derived from it ----
    if (req.method === 'POST' && p === '/api/rig') {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      // THE ELEMENT'S UPLOADED PICTURE MUST SURVIVE A FORM PUSH.
      //
      // `refPath` is written by /api/element-ref and is owned by the server —
      // the page never sends it back, because readRigFromForm only knows about
      // the boxes on screen (enabled, subject, direction, rate, perWall, entry).
      // The whole rig object it sends therefore contains an `element` with NO
      // refPath, and Object.assign REPLACES a nested object wholesale rather
      // than merging into it. So uploading the element picture worked, and then
      // touching any rig control at all — speed, duration, even the subject box
      // the element itself needs — silently wiped the path. The file stayed on
      // disk; the tool just forgot where it was, and generate() then saw no
      // refPath and attached nothing.
      const keptRef = (state.rig && state.rig.element && state.rig.element.refPath) || null;
      state.rig = Object.assign(state.rig || RIG.defaultRig(), body.rig || body);
      if (body.element) state.rig.element = Object.assign(state.rig.element || {}, body.element);
      if (state.rig.element && !state.rig.element.refPath && keptRef) {
        state.rig.element.refPath = keptRef;
      }
      // Keep the legacy field in sync so anything still reading it behaves.
      state.videoMotionMode = state.rig.intent === 'hold' ? 'idle' : 'moving';
      saveState();
      const applied = LEARN.applyCalibration(state.calibration, state.rig);
      return sendJson(res, 200, {
        ok: true, rig: state.rig, applied,
        summary: RIG.describeRig(applied),
        elementPlan: elementPlan(applied),
        // `rules` - the same contract as prose - used to ride along here at
        // 18KB per response. Nothing rendered it once the contract became
        // JSON, and the one thing that still read it (the inspector's "has
        // Apply been pressed" check) was checking an artifact that is never
        // sent. RIG.buildFixedVideoRules still exists for offline reading.
        rulesJson: Object.fromEntries(WALL_IDS.map(w =>
          [w, require('./principles.js').buildLockedJson(w, applied)])),
      });
    }

    // Read back the locked rules the rig currently produces, calibration applied.
    if (req.method === 'GET' && p === '/api/rig-rules') {
      await refreshCentreGradeRef().catch(() => {});
      const applied = LEARN.applyCalibration(state.calibration, state.rig || RIG.defaultRig());
      return sendJson(res, 200, {
        rig: state.rig, applied, summary: RIG.describeRig(applied),
        elementPlan: elementPlan(applied),
        targets: RIG.RIG_TARGETS, geometry: RIG.RIG_GEOMETRY, intents: RIG.INTENTS,
        locks: rigLockPayload(applied),
        // `rules` - the same contract as prose - used to ride along here at
        // 18KB per response. Nothing rendered it once the contract became
        // JSON, and the one thing that still read it (the inspector's "has
        // Apply been pressed" check) was checking an artifact that is never
        // sent. RIG.buildFixedVideoRules still exists for offline reading.
        rulesJson: Object.fromEntries(WALL_IDS.map(w =>
          [w, require('./principles.js').buildLockedJson(w, applied)])),
      });
    }

    // ---- reference media upload (video OR image), streamed straight to disk ----
    // Deliberately NOT the base64-in-JSON shape /api/upload uses: a client
    // blockout clip is routinely hundreds of MB, and base64 inflates it by a
    // third before it even reaches the 60MB body cap.
    if (req.method === 'POST' && p === '/api/upload-ref') {
      const rawName = String(req.headers['x-filename'] || 'reference.mp4');
      const safe = rawName.replace(/[^\w.\-]+/g, '_').slice(-80);
      const dest = path.join(REFS_DIR, `${Date.now()}-${safe}`);
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(dest);
        req.pipe(ws);
        ws.on('finish', resolve);
        ws.on('error', reject);
        req.on('error', reject);
      });
      const stat = fs.statSync(dest);
      if (!stat.size) { try { fs.unlinkSync(dest); } catch (e) {} return sendJson(res, 400, { error: 'empty upload' }); }
      // Optionally attach it to a wall as that wall's motion reference, so it
      // can be re-decoded later without re-uploading.
      const attachTo = String(req.headers['x-wall'] || '');
      if (WALL_IDS.includes(attachTo)) {
        state.walls[attachTo].refVideoPath = dest;
        saveState();
      }
      return sendJson(res, 200, { path: dest, url: `/refs/${path.basename(dest)}`,
                                  bytes: stat.size, filename: safe,
                                  attachedTo: WALL_IDS.includes(attachTo) ? attachTo : null });
    }

    // ---- decode: reverse-engineer a client reference into a rig spec ----
    if (req.method === 'POST' && p === '/api/decode') {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      const { mediaPath, fov, panels, crop, apply } = body;
      if (!mediaPath || !fs.existsSync(mediaPath)) return sendJson(res, 400, { error: 'mediaPath not found' });
      try {
        const probe = await runProbe(mediaPath, { fov, panels, crop });
        const derived = RIG.rigFromProbe(probe, state.rig || RIG.defaultRig());
        // A 3-panel plate also tells us the grade to match. Adopt the CENTRE
        // wall's measured lighting as the reference the locked grade rule
        // quotes — this is what stops a side wall coming back 50 points cooler.
        const cg = probe.panels && probe.panels.CENTER && probe.panels.CENTER.grade;
        if (cg) derived.gradeRef = cg;
        // Keep the FULL per-wall reading, not just the centre's grade: the
        // locked block quotes each side wall's own measured miss and the
        // direction to correct it (buildMeasuredMatchRule). Measuring a set and
        // then not telling the generator what the measurement said is what let
        // the same faults repeat version after version.
        // What the paths block cites. Only the CENTRE is ever needed: the room's
        // geometry derives the other four (see rigpaths.js).
        derived.measuredMotion = {
          source: require('path').basename(mediaPath || 'reference'),
          confidence: (probe.motion && probe.motion.confidence) || null,
          yawDegPerSec: probe.motion && probe.motion.yaw_deg_per_s,
          intent: probe.motion && probe.motion.intent,
          at: new Date().toISOString(),
        };
        if (probe.panels && probe.panels.CENTER) {
          derived.measured = {
            at: new Date().toISOString(),
            grades: Object.fromEntries(Object.entries(probe.panels)
              .filter(([, v]) => v && v.grade).map(([k, v]) => [k, v.grade])),
            horizons: Object.fromEntries(Object.entries(probe.panels)
              .filter(([, v]) => v && v.horizon != null).map(([k, v]) => [k, v.horizon])),
            motion: probe.motion || null,
            issues: (probe.match && probe.match.issues) || [],
          };
        }
        state.decoded = { at: new Date().toISOString(), mediaPath, probe, derived };
        // Adopt the measured GRADE and eyeline regardless — those readings are
        // sound even on a broken plate. But keep the previous camera INTENT when
        // the probe says the intent reading cannot be trusted, rather than
        // baking a misread rotation into every future prompt.
        const trust = !probe.match || probe.match.intent_trustworthy !== false;
        if (apply) {
          const prev = state.rig || RIG.defaultRig();
          const keptIntent = prev.intent, keptSpeed = prev.speedPct;
          state.rig = derived;
          if (!trust) {
            // Speed is derived from the same flow measurement as the intent, so
            // if the intent is untrustworthy the speed is too — restore both,
            // not just the label.
            state.rig.intent = keptIntent;
            state.rig.speedPct = keptSpeed;
            state.rig.speedInferred = false;
            state.rig.intentRejected = derived.intent;
            state.rig.speedRejected = derived.speedPct;
          }
          state.videoMotionMode = state.rig.intent === 'hold' ? 'idle' : 'moving';
          if (derived.speedPct && trust) state.videoCameraSpeedPct = derived.speedPct;
        }
        saveState();
        const applied = LEARN.applyCalibration(state.calibration, apply ? state.rig : derived);
        return sendJson(res, 200, {
          probe, derived, applied, summary: RIG.describeRig(applied),
          rules: Object.fromEntries(WALL_IDS.map(w => [w, RIG.buildFixedVideoRules(w, applied)])),
        locks: rigLockPayload(applied),
        });
      } catch (err) { return sendJson(res, 500, { error: err.message }); }
    }

    // Decode straight from a WALL's own video — no separate upload, and no
    // still image involved at all. Source order: a video explicitly attached
    // to the wall as a motion reference, else that wall's last generated
    // video (downloaded from the CDN first, since the probe needs a local file).
    if (req.method === 'POST' && p === '/api/decode-wall-video') {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      const wall = WALL_IDS.includes(body.wall) ? body.wall : 'center';
      const st = state.walls[wall];
      let mediaPath = st.refVideoPath && fs.existsSync(st.refVideoPath) ? st.refVideoPath : null;
      let origin = mediaPath ? 'attached reference video' : null;
      if (!mediaPath && st.genVideoUrl) {
        try {
          const dest = path.join(REFS_DIR, `${wall}-decode-${Date.now()}.mp4`);
          await downloadFile(st.genVideoUrl, dest);
          mediaPath = dest; origin = `${wall} wall's generated video`;
        } catch (e) {
          return sendJson(res, 500, { error: `Could not download ${wall}'s video: ${e.message}` });
        }
      }
      if (!mediaPath) {
        return sendJson(res, 400, { error:
          `The ${wall} wall has no video to decode. Drop a reference clip on the decode slot, or generate ` +
          `a ${wall} video first. A still image cannot be decoded — a camera move needs a clip.` });
      }
      try {
        const probe = await runProbe(mediaPath, { fov: body.fov, panels: body.panels });
        const derived = RIG.rigFromProbe(probe, state.rig || RIG.defaultRig());
        // A 3-panel plate also tells us the grade to match. Adopt the CENTRE
        // wall's measured lighting as the reference the locked grade rule
        // quotes — this is what stops a side wall coming back 50 points cooler.
        const cg = probe.panels && probe.panels.CENTER && probe.panels.CENTER.grade;
        if (cg) derived.gradeRef = cg;
        // Keep the FULL per-wall reading, not just the centre's grade: the
        // locked block quotes each side wall's own measured miss and the
        // direction to correct it (buildMeasuredMatchRule). Measuring a set and
        // then not telling the generator what the measurement said is what let
        // the same faults repeat version after version.
        // What the paths block cites. Only the CENTRE is ever needed: the room's
        // geometry derives the other four (see rigpaths.js).
        derived.measuredMotion = {
          source: require('path').basename(mediaPath || 'reference'),
          confidence: (probe.motion && probe.motion.confidence) || null,
          yawDegPerSec: probe.motion && probe.motion.yaw_deg_per_s,
          intent: probe.motion && probe.motion.intent,
          at: new Date().toISOString(),
        };
        if (probe.panels && probe.panels.CENTER) {
          derived.measured = {
            at: new Date().toISOString(),
            grades: Object.fromEntries(Object.entries(probe.panels)
              .filter(([, v]) => v && v.grade).map(([k, v]) => [k, v.grade])),
            horizons: Object.fromEntries(Object.entries(probe.panels)
              .filter(([, v]) => v && v.horizon != null).map(([k, v]) => [k, v.horizon])),
            motion: probe.motion || null,
            issues: (probe.match && probe.match.issues) || [],
          };
        }
        state.decoded = { at: new Date().toISOString(), mediaPath, origin, probe, derived };
        if (body.apply !== false) {
          state.rig = derived;
          state.videoMotionMode = derived.intent === 'hold' ? 'idle' : 'moving';
          if (derived.speedPct) state.videoCameraSpeedPct = derived.speedPct;
        }
        saveState();
        const applied = LEARN.applyCalibration(state.calibration, state.rig);
        return sendJson(res, 200, {
          probe, derived, applied, origin, summary: RIG.describeRig(applied),
          rules: Object.fromEntries(WALL_IDS.map(w => [w, RIG.buildFixedVideoRules(w, applied)])),
        locks: rigLockPayload(applied),
        });
      } catch (err) { return sendJson(res, 500, { error: err.message }); }
    }

    // One click: write the per-wall ambient-motion text for LEFT and RIGHT so
    // their existing reference photos can be animated under the current rig.
    // Each wall reads ITS OWN photo; the rig movement is already carried by the
    // locked block, and the bot is briefed on it via promptBotRigContext.
    // /api/draft-side-animation was removed with the "Animate the side walls"
    // card in v5.5. It ran buildVideoInstruction over both side walls at once —
    // exactly what each wall's own "Generate descriptive prompt" button already
    // does, through the same builder. One job, one button.

    // ---- ratings: thumbs up/down on a generation ----
    if (req.method === 'POST' && p === '/api/rate') {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      const { wall, id, rating } = body;
      if (!WALL_IDS.includes(wall)) return sendJson(res, 400, { error: 'bad wall' });
      let target = id;
      if (!target) {
        // No id means "rate what is on screen now" — snapshot the current state
        // so the rating has something durable to attach to.
        const v = LEARN.snapshotWall(state.history, wall, state.walls[wall], 'rated', { sceneKey: state.centreRefHash });
        if (!v) return sendJson(res, 400, { error: 'nothing generated on this wall yet to rate' });
        target = v.id;
      }
      const v = LEARN.rateVersion(state.history, wall, target, rating);
      if (!v) return sendJson(res, 404, { error: 'no such version' });
      saveState();
      return sendJson(res, 200, { ok: true, id: v.id, rating: v.rating,
                                  tally: LEARN.ratingTally(state.history) });
    }
    if (req.method === 'GET' && p === '/api/ratings') {
      return sendJson(res, 200, { tally: LEARN.ratingTally(state.history) });
    }

    // ---- version history ----
    if (req.method === 'GET' && p === '/api/history') {
      const wall = url.searchParams.get('wall');
      return sendJson(res, 200, wall ? { [wall]: state.history[wall] || [] } : state.history);
    }
    if (req.method === 'POST' && p === '/api/history/restore') {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      const { wall, id } = body;
      if (!WALL_IDS.includes(wall)) return sendJson(res, 400, { error: 'bad wall' });
      const v = LEARN.findVersion(state.history, wall, id);
      if (!v) return sendJson(res, 404, { error: 'no such version' });
      // Snapshot what we are about to overwrite, so Restore is itself undoable.
      LEARN.snapshotWall(state.history, wall, state.walls[wall], 'restore-point', { sceneKey: state.centreRefHash });
      Object.assign(state.walls[wall], {
        imagePrompt: v.imagePrompt || '', videoPrompt: v.videoPrompt || '', editPrompt: v.editPrompt || '',
        videoEditPrompt: v.videoEditPrompt || '',
        genImageUrl: v.genImageUrl || null, genVideoUrl: v.genVideoUrl || null,
        approvedImagePath: v.approvedImagePath || null, uploadedImagePath: v.uploadedImagePath || null,
        genImageStatus: v.genImageUrl ? 'completed' : null,
        genVideoStatus: v.genVideoUrl ? 'completed' : null,
      });
      saveState();
      return sendJson(res, 200, { ok: true, restored: v.id, wall: state.walls[wall] });
    }

    // ---- calibration: the self-relearning loop ----
    if (req.method === 'GET' && p === '/api/calibration') {
      return sendJson(res, 200, {
        calibration: state.calibration, targets: RIG.RIG_TARGETS,
        window: LEARN.CALIBRATION_WINDOW,
        due: LEARN.due(state.calibration),
        untilNext: Math.max(0, LEARN.CALIBRATION_WINDOW - state.calibration.generations),
      });
    }
    // Measure a finished tri-wall set and feed it to the calibrator. Takes a
    // local path to a stitched plate, or measures whatever it is given.
    if (req.method === 'POST' && p === '/api/calibration/measure') {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      const { mediaPath, crop, fov } = body;
      let probe = null, probeError = null;
      if (mediaPath && fs.existsSync(mediaPath)) {
        try { probe = await runProbe(mediaPath, { fov, panels: '3', crop }); }
        catch (e) { probeError = e.message; }
      }
      LEARN.recordSample(state.calibration, probe, { intent: (state.rig || {}).intent, mediaPath });
      let result = null;
      if (LEARN.due(state.calibration)) result = LEARN.recalibrate(state.calibration);
      saveState();
      return sendJson(res, 200, {
        recorded: true, probeError, probe,
        recalibrated: !!result, result,
        untilNext: Math.max(0, LEARN.CALIBRATION_WINDOW - state.calibration.generations),
        calibration: state.calibration,
      });
    }
    // Measure the CURRENT three-wall set with no stitching and no manual step:
    // download each wall's finished video, probe each as its own single view,
    // then assemble the three into the same {LEFT,CENTER,RIGHT} shape a real
    // tri-wall plate would have produced. This is what makes the loop
    // automatic — the user never has to export a plate to get calibrated.
    if (req.method === 'POST' && p === '/api/calibration/measure-set') {
      const urls = WALL_IDS.map(w => [w, state.walls[w].genVideoUrl]);
      const missing = urls.filter(([w, u]) => !u).map(([w]) => w);
      if (missing.length) {
        return sendJson(res, 400, { error: `No finished video yet for: ${missing.join(', ')}. ` +
          `All three walls need a completed video before a set can be measured.` });
      }
      const panels = {}; const errors = [];
      let fov = 60, dur = null;
      for (const [wall, u] of urls) {
        try {
          const dest = path.join(REFS_DIR, `cal-${wall}-${Date.now()}.mp4`);
          await downloadFile(u, dest);
          const pr = await runProbe(dest, { panels: '1', fov });
          const c = (pr.panels && pr.panels.CENTER) || null;
          if (c) panels[wall.toUpperCase()] = c;
          if (pr.duration_s) dur = pr.duration_s;
          try { fs.unlinkSync(dest); } catch (e) {}
        } catch (e) { errors.push(`${wall}: ${e.message}`); }
      }
      if (Object.keys(panels).length < 3) {
        return sendJson(res, 500, { error: `Could not measure all three walls. ${errors.join(' | ')}` });
      }
      const L = Math.abs(panels.LEFT.dx_bg), R = Math.abs(panels.RIGHT.dx_bg);
      const synthetic = {
        duration_s: dur,
        panels,
        motion: {
          intent: (state.rig || {}).intent || 'push_in',
          lr_symmetry_ratio: +(Math.max(L, R) / Math.max(1e-4, Math.min(L, R))).toFixed(3),
          is_zoom_not_move: Math.abs(panels.CENTER.parallax) < RIG.RIG_TARGETS.minCentreParallax,
          yaw_deg_per_s: null, pitch_deg_per_s: null, push_rate_pct_per_s: null,
        },
      };
      // If the human marked this set down, record that so the calibrator skips
      // it rather than learning from output that was rejected.
      const recent = WALL_IDS.map(w => (state.history[w] || [])[0]).filter(Boolean);
      const anyDown = recent.some(v => v.rating === 'down');
      LEARN.recordSample(state.calibration, synthetic,
        { source: 'measure-set', intent: synthetic.motion.intent, rating: anyDown ? 'down' : undefined });
      let result = null;
      if (LEARN.due(state.calibration)) result = LEARN.recalibrate(state.calibration);
      saveState();
      return sendJson(res, 200, {
        measured: synthetic, errors,
        recalibrated: !!result, result,
        untilNext: Math.max(0, LEARN.CALIBRATION_WINDOW - state.calibration.generations),
        calibration: state.calibration,
        verdict: {
          symmetry: synthetic.motion.lr_symmetry_ratio,
          symmetryTarget: RIG.RIG_TARGETS.lrSymmetry,
          symmetryOk: Math.abs(synthetic.motion.lr_symmetry_ratio - RIG.RIG_TARGETS.lrSymmetry)
                      <= RIG.RIG_TARGETS.lrSymmetryTolerance,
          centreParallax: panels.CENTER.parallax,
          zoomNotMove: synthetic.motion.is_zoom_not_move,
          sidesDivergeOutward: panels.LEFT.dx_bg < 0 && panels.RIGHT.dx_bg > 0,
        },
      });
    }

    if (req.method === 'POST' && p === '/api/calibration/reset') {
      state.calibration = LEARN.emptyCalibration();
      saveState();
      return sendJson(res, 200, { ok: true, calibration: state.calibration });
    }
    if (req.method === 'POST' && p === '/api/calibration/toggle') {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      state.calibration.enabled = !!body.enabled;
      saveState();
      return sendJson(res, 200, { ok: true, calibration: state.calibration });
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Tri-Wall server listening on http://localhost:${PORT}`);
});
