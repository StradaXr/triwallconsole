// learning.js — version history + the self-recalibrating feedback loop.
//
// TWO JOBS, both persistence-shaped, deliberately in one file because the
// calibrator reads what the history records.
//
// 1. HISTORY. The original tool overwrote genImageUrl on every regenerate and
//    overwrote the textarea on every Improve. Iterating toward a better image
//    destroyed the previous one. Every generation, edit and prompt rewrite now
//    appends a version record first, so nothing is lost and any earlier state
//    can be restored.
//
// 2. CALIBRATION. Every completed VIDEO set is measured by motion_probe.py and
//    scored against RIG_TARGETS. After every CALIBRATION_WINDOW generations the
//    tool re-derives its own correction factors from that evidence and applies
//    them to the next prompts. This is the "re-learn itself" loop: it is a
//    measured feedback controller, not a model that retrains — it adjusts the
//    numbers the locked blocks state, based on what the last N generations
//    actually produced when measured.
//
// DELIBERATELY BOUNDED: corrections are clamped and the whole thing can be
// switched off. An automatic loop that can drift without limit, applied to
// prompts that cost 110 credits a render, is not something to leave unbounded.

const fs = require('fs');
const path = require('path');
const { RIG_TARGETS } = require('./rig.js');

const CALIBRATION_WINDOW = 10;   // "re-learn after every 10 generations"
const MAX_VERSIONS = 40;         // per wall per kind — plenty, bounded
const CLAMP = { speedMul: [0.4, 2.5], sideBias: [0.5, 2.0] };

// ------------------------------------------------------------------ history ---
function emptyHistory() {
  return { left: [], center: [], right: [] };
}

// kind: 'image' | 'video' | 'edit' | 'prompt'
function pushVersion(store, wall, kind, record) {
  if (!store[wall]) store[wall] = [];
  store[wall].unshift(Object.assign({
    id: `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    kind,
    at: new Date().toISOString(),
  }, record));
  if (store[wall].length > MAX_VERSIONS) store[wall].length = MAX_VERSIONS;
  return store[wall][0];
}

function findVersion(store, wall, id) {
  return (store[wall] || []).find(v => v.id === id) || null;
}

// Snapshot a wall's CURRENT state before something overwrites it. Called at the
// top of every mutating endpoint — this is what makes "I liked the last one
// better" recoverable instead of gone.
function snapshotWall(store, wall, wallState, kind, extra) {
  const hasContent = wallState.genImageUrl || wallState.genVideoUrl ||
                     wallState.imagePrompt || wallState.videoPrompt || wallState.editPrompt || wallState.videoEditPrompt;
  if (!hasContent) return null;
  return pushVersion(store, wall, kind, Object.assign({
    // Which picture this version belongs to. likedExemplar filters on it so a
    // thumbs-up on one scene can never be shown as an example for another.
    sceneKey: (extra && extra.sceneKey) || null,
    imagePrompt: wallState.imagePrompt || '',
    videoPrompt: wallState.videoPrompt || '',
    editPrompt: wallState.editPrompt || '',
    videoEditPrompt: wallState.videoEditPrompt || '',
    genImageUrl: wallState.genImageUrl || null,
    genVideoUrl: wallState.genVideoUrl || null,
    approvedImagePath: wallState.approvedImagePath || null,
    uploadedImagePath: wallState.uploadedImagePath || null,
  }, extra || {}));
}

// ------------------------------------------------------------------ ratings ---
// A thumbs up/down on each generation, and — this is the point — it CHANGES
// what the tool learns. Two uses, both principled:
//
//   1. Never calibrate toward output you rejected. The recalibration loop
//      previously averaged every measured set. Averaging in the ones a human
//      disliked teaches the tool to reproduce them. Disliked sets are now
//      excluded from the window entirely.
//   2. Liked prompts become exemplars. The prompt bot is shown what wording
//      produced an approved result for this wall, so it drifts toward it
//      instead of re-deriving from scratch every time.
//
// A rating with no effect would be a button that lies about being useful.
function rateVersion(store, wall, id, rating) {
  const v = (store[wall] || []).find(x => x.id === id);
  if (!v) return null;
  v.rating = rating === 'up' ? 'up' : rating === 'down' ? 'down' : null;
  v.ratedAt = new Date().toISOString();
  return v;
}

// The most recent liked prompt for a wall, for use as an exemplar.
// An approved example is only an example for THE SAME PICTURE.
//
// Without the sceneKey filter this returned the newest liked prompt from any
// scene the tool had ever run, so a diner interior was shown a liked
// description of a crowd, a stage and screens and told to match its detail.
// That is prompt bleed: the writer either copies it or has to notice and
// discard it, and the second delivered set did the former. sceneKey is the
// centre reference hash, so "the same picture" means literally the same
// centre plate.
function likedExemplar(store, wall, field, sceneKey) {
  const v = (store[wall] || []).find(x =>
    x.rating === 'up' &&
    (x[field] || '').trim() &&
    (!sceneKey || !x.sceneKey || x.sceneKey === sceneKey));
  return v ? v[field].trim() : null;
}

function ratingTally(store) {
  const out = {};
  Object.keys(store || {}).forEach(w => {
    const list = store[w] || [];
    out[w] = { up: list.filter(v => v.rating === 'up').length,
               down: list.filter(v => v.rating === 'down').length };
  });
  return out;
}

// --------------------------------------------------------------- calibration ---
function emptyCalibration() {
  return {
    enabled: true,
    generations: 0,           // counted since the last recalibration
    totalGenerations: 0,
    // Applied corrections. 1.0 / 1.0 means "state the numbers as given".
    speedMultiplier: 1.0,     // scales the km/h written into the locked rules
    sideBias: 1.0,            // >1 tells the weaker side wall to move more
    lastCalibratedAt: null,
    history: [],              // one entry per recalibration, for auditing
    samples: [],              // measured sets awaiting the next recalibration
    notes: [],
  };
}

// Record one measured generation. `probe` is motion_probe.py output for a
// tri-wall set (3-panel), or null if it could not be measured.
function recordSample(cal, probe, meta) {
  cal.generations += 1;
  cal.totalGenerations += 1;
  // A set the human marked down is evidence of what NOT to do — averaging it
  // into the correction factors would teach the tool to reproduce it.
  if (meta && meta.rating === 'down') {
    cal.notes.unshift(`Skipped a down-rated set in calibration (${new Date().toISOString()}).`);
    if (cal.notes.length > 20) cal.notes.length = 20;
    return cal;
  }
  if (!probe || !probe.motion) return cal;
  const m = probe.motion;
  const p = probe.panels || {};
  const L = p.LEFT ? Math.abs(p.LEFT.dx_bg) : null;
  const R = p.RIGHT ? Math.abs(p.RIGHT.dx_bg) : null;
  const Crad = p.CENTER ? Math.abs(p.CENTER.radial) : null;
  cal.samples.push({
    at: new Date().toISOString(),
    intent: m.intent,
    symmetry: m.lr_symmetry_ratio,
    sideToCentre: (L != null && R != null && Crad) ? +(((L + R) / 2) / Crad).toFixed(3) : null,
    centreParallax: p.CENTER ? p.CENTER.parallax : null,
    isZoomNotMove: !!m.is_zoom_not_move,
    leftFaster: (L != null && R != null) ? L > R : null,
    meta: meta || {},
  });
  if (cal.samples.length > CALIBRATION_WINDOW * 3) {
    cal.samples = cal.samples.slice(-CALIBRATION_WINDOW * 3);
  }
  return cal;
}

function due(cal) {
  return cal.enabled && cal.generations >= CALIBRATION_WINDOW;
}

function clamp(v, [lo, hi]) { return Math.max(lo, Math.min(hi, v)); }
function median(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

// The actual learning step. Compares the window's measurements against
// RIG_TARGETS and nudges the correction factors toward closing the gap.
// Deliberately damped (moves a fraction of the way, not all of it) so one
// unusual batch cannot swing the next ten.
function recalibrate(cal) {
  const window = cal.samples.slice(-CALIBRATION_WINDOW);
  const measured = window.filter(s => s.sideToCentre != null || s.symmetry != null);
  const out = {
    at: new Date().toISOString(),
    generationsCovered: cal.generations,
    samplesUsed: measured.length,
    before: { speedMultiplier: cal.speedMultiplier, sideBias: cal.sideBias },
    findings: [],
  };

  if (measured.length < 3) {
    out.findings.push(`Only ${measured.length} measurable set(s) in this window — not enough ` +
      `evidence to adjust anything. Corrections left unchanged.`);
    cal.generations = 0;
    cal.history.unshift(out);
    return out;
  }

  const DAMP = 0.5;   // move half-way toward the target, never all the way

  // --- side-to-centre coupling -> speed multiplier -------------------------
  const coup = median(measured.map(s => s.sideToCentre).filter(v => v != null));
  if (coup != null && coup > 0) {
    const ratio = RIG_TARGETS.sideToCentreCoupling / coup;
    if (Math.abs(coup - RIG_TARGETS.sideToCentreCoupling) > RIG_TARGETS.sideToCentreTolerance) {
      const next = clamp(cal.speedMultiplier * (1 + (ratio - 1) * DAMP), CLAMP.speedMul);
      out.findings.push(
        `Side-to-centre coupling measured ${coup.toFixed(2)} against a target of ` +
        `${RIG_TARGETS.sideToCentreCoupling} (the UE5 reference). The side walls are moving ` +
        `${coup > RIG_TARGETS.sideToCentreCoupling ? 'too fast' : 'too slowly'} relative to the ` +
        `centre's push. Speed multiplier ${cal.speedMultiplier.toFixed(2)} -> ${next.toFixed(2)}.`);
      cal.speedMultiplier = +next.toFixed(3);
    } else {
      out.findings.push(`Side-to-centre coupling ${coup.toFixed(2)} is within tolerance of ` +
        `${RIG_TARGETS.sideToCentreCoupling}. No speed change.`);
    }
  }

  // --- left/right symmetry -> side bias ------------------------------------
  const sym = median(measured.map(s => s.symmetry).filter(v => v != null));
  if (sym != null) {
    if (sym > RIG_TARGETS.lrSymmetry + RIG_TARGETS.lrSymmetryTolerance) {
      const leftFasterCount = measured.filter(s => s.leftFaster === true).length;
      const which = leftFasterCount > measured.length / 2 ? 'left' : 'right';
      const next = clamp(cal.sideBias * (1 + (sym - RIG_TARGETS.lrSymmetry) * DAMP * 0.5), CLAMP.sideBias);
      out.findings.push(
        `Left/right symmetry measured ${sym.toFixed(2)} against a target of ${RIG_TARGETS.lrSymmetry} ` +
        `— the two side walls are not mirroring each other, with ${which} consistently faster. ` +
        `Side bias ${cal.sideBias.toFixed(2)} -> ${next.toFixed(2)}, and the locked rules will now ` +
        `state the mirror requirement explicitly. Consider the Genjutsu mirror fix on affected sets.`);
      cal.sideBias = +next.toFixed(3);
      out.recommendGenjutsu = true;
      out.slowerSide = which === 'left' ? 'right' : 'left';
    } else {
      out.findings.push(`Left/right symmetry ${sym.toFixed(2)} is within tolerance. No bias change.`);
    }
  }

  // --- zoom-instead-of-move (a prompt failure, not a number failure) -------
  const zooms = measured.filter(s => s.isZoomNotMove).length;
  if (zooms > 0) {
    out.findings.push(`${zooms} of ${measured.length} sets read as a LENS ZOOM rather than physical ` +
      `camera movement (centre parallax below ${RIG_TARGETS.minCentreParallax}). This is not fixable ` +
      `by a speed number — it needs the parallax clause, which is already in the locked block. ` +
      `Flagging for human review rather than auto-adjusting.`);
    out.needsHuman = true;
  }

  out.after = { speedMultiplier: cal.speedMultiplier, sideBias: cal.sideBias };
  cal.lastCalibratedAt = out.at;
  cal.generations = 0;
  cal.history.unshift(out);
  if (cal.history.length > 25) cal.history.length = 25;
  return out;
}

// What the page should actually write into the locked rules right now.
function applyCalibration(cal, rig) {
  if (!cal || !cal.enabled) return rig;
  const out = Object.assign({}, rig);
  out.speedPct = Math.max(1, Math.round((rig.speedPct ?? 100) * cal.speedMultiplier));
  out.calibrated = cal.speedMultiplier !== 1.0 || cal.sideBias !== 1.0;
  out.calibrationNote = out.calibrated
    ? `Calibrated from ${cal.totalGenerations} measured generation(s): speed x${cal.speedMultiplier}, ` +
      `side bias x${cal.sideBias}.`
    : null;
  return out;
}

module.exports = {
  CALIBRATION_WINDOW, emptyHistory, pushVersion, findVersion, snapshotWall,
  rateVersion, likedExemplar, ratingTally,
  emptyCalibration, recordSample, due, recalibrate, applyCalibration,
};
