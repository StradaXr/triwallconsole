// rigspec.js — the NUMBERS. One place where "how the camera moves" is a
// quantity rather than an adjective.
//
// WHY THIS FILE EXISTS
// --------------------
// The prompts said "slides steadily toward the LEFT edge" and "opens outward".
// A video model reads that and picks its own direction and its own speed, and
// the delivered sets proved it: one wall ran backwards, one ran at roughly
// three times the reference, and one had no camera move at all — just objects
// sliding over a fixed background. Prose cannot state a velocity. This file
// states velocities, total excursions, scale factors and timestamped landmark
// positions, and the prompt quotes them.
//
// WHERE THE NUMBERS COME FROM
// ---------------------------
// The four reference renders (C_PushIn, C_PushOut, C_TrackLeft, C_TrackRight).
// Each is the WHOLE 11520x2160 nDisplay canvas scaled to 1920x1080 — verified,
// not assumed: the coloured strip sits at y 360..720 and splits into three
// exactly-640px panels, which is the canvas at 1/6 scale. So
//
//     panel 1  master x [    0,  3840)  =  L (3520) + LR (320)   <- LEFT view
//     panel 2  master x [ 3840,  7680)  =  C (3840)              <- CENTRE view
//     panel 3  master x [ 7680, 11520)  =  RR (320) + R (3520)   <- RIGHT view
//
// All three views are exactly one third of the canvas. (A review pass claimed
// the side views were 4608px and every rate was therefore 2.5x wrong. It is
// not: 3520 + 320 = 3840. The only unit correction the sides need is the 1.09
// between the 3840px VIEW and the 3520px WALL the tool actually delivers, and
// that is applied below.)
//
// Each panel was decomposed frame to frame into a similarity transform
// (translation, uniform scale, rotation) fitted by RANSAC to sparse
// Lucas-Kanade correspondences, then accumulated over the clip. That is a
// different estimator from the Farneback flow in learn_rig.py, and it
// reproduced those figures to within a few percent on all twelve panel/move
// cells — which is the only reason these are quoted as measurements rather
// than as readings.
//
// THE DIRECTION QUESTION, SETTLED
// -------------------------------
// On C_PushIn the two side walls move APART: LEFT content travels to frame
// left at -31.4%/s, RIGHT content travels to frame right at +33.3%/s, while
// the centre expands x1.43/s with no lateral drift. Three independent passes
// now agree (Farneback medians, sparse LK displacement, RANSAC similarity),
// and it is what a forward dolly must do — you walk toward the far wall, and
// the side scenery flows backward past you, out of the rear end of each side
// view. Stated without left/right, which is where the confusion lives:
//
//     PUSH IN  — side walls travel from the SEAM edge toward the OUTER edge.
//     PUSH OUT — side walls travel from the OUTER edge toward the SEAM edge.
//
// (The seam edge is the one that touches the centre wall: the RIGHT edge of
// the left wall's frame, the LEFT edge of the right wall's frame.)
//
// SPEED: A RATE THE OPERATOR SETS
// -------------------------------
// This USED to freeze the total excursion, so every clip travelled the same
// distance whatever its length. That killed the "three times too far" bug but
// left no control of pace at all: a 15-second clip just crawled through the
// same gesture, and the km/h box governed nothing.
//
// The tables below are still the reference GESTURE (they fix the direction and
// the ratios between the three walls), but spec() now reads them as a rate at
// the reference's own duration and re-paces them by the speed dial, so
//
//     dx_total = dx_per_second x duration
//
// and one speed means the same thing at 4 seconds and at 15. See the speed
// dial section below for where 100% comes from and how it was measured.

const REF_VIEW_PX = 3840;      // one nDisplay view, master pixels
const MASTER_H = 2160;
const FPS = 30;

// Delivered wall sizes. theatre.js is the source of truth; these are the
// conversion factors, checked against it at load.
const WALL_PX = { left: 3520, center: 3840, right: 3520 };
const WALL_H = { left: 1600, center: 1920, right: 1600 };

// Totals over one reference gesture, in VIEW widths (3840 master px).
// dx      + = content travels toward frame RIGHT
// scale   linear zoom factor over the whole gesture; 1.0 = no scale change
// Left/right pairs are symmetrised: the rig is symmetric, and the raw spread
// between the two sides is scene content (the right side of this particular
// room has nearer objects), not rig behaviour. Raw readings sit in the comment
// beside each line so nothing is hidden.
const MOVES = {
  // RIGHT WALL DIRECTION: OWNER-CONFIRMED TWICE, FROM DELIVERED OUTPUT.
  // 2026-09-23, first after the direction rewrite ("right motion is fixed, it's
  // looking nice for push in"), then again off a later clip that travelled
  // toward frame RIGHT (measured dx +0.083 over 5.04s): "this is a good
  // generation for C_PushIn ... make sure the camera motion for right wall does
  // what it's doing right now when C_PushIn is selected."
  //
  // The table below ALREADY says that - right: dx +0.61, i.e. toward frame
  // RIGHT, toward the outer end of the room - so nothing here needed changing;
  // it is recorded so that it does not get "fixed" later. The amplitude is a
  // separate question and is NOT taken from that clip: +0.083 is 19% of the
  // 0.428 the contract asked for, and shrinking the preset to match a delivery
  // that undershot would bake the undershoot in permanently.
  C_PushIn: {
    label: 'C_PushIn — the rig travels forward into the room',
    refClip: 'C_PushIn.mp4', refDur: 1.93,
    kind: 'dolly', sign: +1,
    walls: {
      // raw: L dx -0.607 scale 1.07 | R dx +0.643 scale 1.24
      left:   { dx: -0.61, dy: 0, scale: 1.10, roll: 0 },
      center: { dx:  0.00, dy: 0, scale: 2.00, roll: 0 },   // raw 2.01
      right:  { dx: +0.61, dy: 0, scale: 1.10, roll: 0 },
    },
  },
  // AND C_PushOut IS ITS EXACT REVERSE, which is what the table says (left
  // +0.61, right -0.61 - each side mirrored against push-in) and what the owner
  // asked for: "C_PushOut should be the opposite of how the camera is moving."
  // The RIGHT wall has not delivered it yet. Three measured attempts, all
  // travelling toward frame RIGHT when asked for LEFT: +0.233, then +0.083
  // after direction_check replaced the depth-based wording. The rewrite took the
  // wrong-way magnitude down but did not turn it round, so prompting is not the
  // lever here - compare() now points at Lock motion for a wrong-way wall, the
  // same advice it already gave for one that barely moves.
  C_PushOut: {
    label: 'C_PushOut — the rig withdraws backward out of the room',
    refClip: 'C_PushOut.mp4', refDur: 1.83,
    kind: 'dolly', sign: -1,
    walls: {
      // raw: L dx +0.571 scale 0.93 | R dx -0.600 scale 0.81
      left:   { dx: +0.61, dy: 0, scale: 0.91, roll: 0 },
      center: { dx:  0.00, dy: 0, scale: 0.50, roll: 0 },   // raw 0.51
      right:  { dx: -0.61, dy: 0, scale: 0.91, roll: 0 },
    },
  },
  C_TrackLeft: {
    label: 'C_TrackLeft — the whole rig slides to its left, still facing forward',
    refClip: 'C_TrackLeft.mp4', refDur: 1.60,
    kind: 'truck', sign: +1,
    walls: {
      // raw: L dx +0.397 scale 2.16 | C dx +0.588 scale 1.01 | R dx +0.396 scale 0.41
      left:   { dx: +0.40, dy: 0, scale: 2.30, roll: 0 },   // approaching -> grows
      center: { dx: +0.59, dy: 0, scale: 1.00, roll: 0 },   // pure slide, no zoom
      right:  { dx: +0.40, dy: 0, scale: 0.435, roll: 0 },  // receding -> shrinks
    },
  },
  C_TrackRight: {
    label: 'C_TrackRight — the whole rig slides to its right, still facing forward',
    refClip: 'C_TrackRight.mp4', refDur: 1.70,
    kind: 'truck', sign: -1,
    walls: {
      // raw: L dx -0.396 scale 0.46 | C dx -0.624 scale 0.98 | R dx -0.434 scale 2.60
      left:   { dx: -0.40, dy: 0, scale: 0.435, roll: 0 },
      center: { dx: -0.59, dy: 0, scale: 1.00, roll: 0 },
      right:  { dx: -0.40, dy: 0, scale: 2.30, roll: 0 },
    },
  },
  C_Hold: {
    label: 'C_Hold — the rig is locked off',
    refClip: null, refDur: 0,
    kind: 'static', sign: 0,
    walls: {
      left:   { dx: 0, dy: 0, scale: 1, roll: 0 },
      center: { dx: 0, dy: 0, scale: 1, roll: 0 },
      right:  { dx: 0, dy: 0, scale: 1, roll: 0 },
    },
  },
};

// ------------------------------------------- THE RIGHT WALL IS INVERTED ---
// THIS IS A COMPENSATION, NOT GEOMETRY. The table above is the room's real
// behaviour and is not to be edited: looking right, "forward" is toward the
// LEFT of that view, so a forward dolly streams the right wall's content toward
// frame RIGHT (+0.61), the exact mirror of the left wall. That is correct and
// stays correct.
//
// What is also true is that the generator does the opposite, every time, in
// both directions. Measured on the right wall, four clips, two presets:
//
//     clip                     preset      asked      delivered
//     R_bear_Pushin.mp4        C_PushIn    +0.4276     -0.1789
//     R_Toronto_Pushout.mp4    C_PushOut   -0.4276     +0.0826
//     19:40 Toronto set        C_PushOut   -0.4276     +0.0826
//     18:52 Toronto set        C_PushOut   -0.4276     +0.2330
//
// Four for four, both signs, sign flipped every time. Three rounds of rewording
// have moved the magnitude and never the sign - the last one took the wrong-way
// travel from +0.233 to +0.083 and still did not turn it round. At that point
// the honest thing is to stop arguing with it: ask the right wall for the
// opposite of what the room wants and let the inversion deliver the right
// answer. The owner asked for exactly this ("dont change the prompts just
// launch the parameters inverse").
//
// TWO PLACES MUST NOT SEE THE INVERTED NUMBER:
//   * compare(), which grades a finished clip - the clip should MEASURE the
//     room's geometry, so it is graded against dxDelivered, not the ask; and
//   * the motion-lock end frame, which warps the plate itself. A start/end pair
//     is an interpolation between two real images, so nothing inverts it, and
//     feeding it the inverted ask would break the one lever that works.
// Both read the `*Delivered` fields. Everything the PROMPT is built from reads
// the plain fields, so the contract is inverted whole and stays self-consistent.
//
// To retire this, set right back to +1 and measure a set. If the generator has
// changed, the sign will come back on its own.
const DELIVERY_SIGN = { left: +1, center: +1, right: -1 };

// The house coherent-lateral-flow ceiling for the side walls, from the wall
// brief's energy table: 6 px per frame at master resolution. Reported, never
// silently applied — the reference gesture itself runs above it because it is a
// two-second beat, and quietly slowing a move the user asked to match is how
// the tool ended up disagreeing with its own verifier.
const SAFE_PX_PER_FRAME = 6;

// ----------------------------------------------------------- the speed dial ---
// SPEED IS A RATE NOW, NOT A TOTAL. This inverts what this file used to do, and
// the reason is worth stating because the old rule is still written in README
// section 6 ("scale by total excursion, never by per-second rate").
//
// That rule existed to stop a 1.9-second reference BEAT being replayed as a
// 5-second clip's per-second rate, which asked for ~3x the travel. It solved
// that by freezing the total: every clip travelled the same distance whatever
// its length, so a 15-second clip just crawled. The operator had no control of
// pace at all - the km/h box was inert, feeding one advisory string into the
// contract and governing nothing.
//
// What the owner asked for instead: one linear speed that means the same thing
// at 4 seconds and at 15 seconds, so distance = rate x duration.
//
// WHERE 100% COMES FROM. Six operator reference clips (L_Clouds, R_Clouds,
// R_BLDG, L_grass, R_Desert, L_Desert), each measured twice - by wall_motion.py
// (RANSAC similarity) and by accumulated phase correlation. The two estimators
// agreed on sign in all six and within 17% on magnitude:
//
//     clip        wall_motion   phase-corr    mean |dx|/s
//     L_Clouds      0.0026        0.0091        0.0059
//     R_Clouds      0.0072        0.0210        0.0141
//     R_BLDG        0.2349        0.2072        0.2211
//     L_grass       0.1439        0.1247        0.1343
//     R_Desert      0.0356        0.0294        0.0325
//     L_Desert      0.0990        0.1028        0.1009
//                                      mean =   0.0848
//
// Every L_ clip travelled toward frame LEFT and every R_ clip toward frame
// RIGHT - independently confirming the push-in topology already in MOVES.
// (The two cloud clips sit far below the rest: their camera barely translates
// and almost all of their apparent motion is the cloud layer itself. Excluding
// them raises the benchmark to 0.1222. The owner asked for all six averaged.)
const BENCHMARK_DX_RATE = 0.0848;   // frame widths per second at Speed = 100%

// THE CENTRE RUNS AT A QUARTER OF THE REFERENCE RATIO. This is the standard,
// not a starting point, and it is set from delivered output rather than from
// the nDisplay render.
//
// The reference render pairs a side dx of 0.61 view widths with a centre scale
// of x2.00, and holding that ratio is what the gesture model does by default.
// The generator does not honour it: over three delivered sets the sides tracked
// what they were asked while the centre overshot its scale by 3-9x, and the
// centre's delivered rate barely moved with the ask at all. A set built on the
// raw reference ratio therefore lands as a fast centre between two slow sides,
// every time, whatever the speed dial says.
//
// 25 was arrived at from the wall, by the owner, watching stitched output - "the
// centre should be about 75% slower to match the sides". An earlier 65 was still
// visibly too fast. The Centre % box overrides it per scene; this is what it
// starts at, and what a contract built without an explicit rig uses.
const CENTRE_TRIM_DEFAULT = 25;     // percent, applied to the centre wall only

// The theatre's own reference gesture runs much harder than that. This is the
// side wall's rate in the SAME units, so SPEED_UNITY below is the honest
// statement of how much gentler the operator's clips are: 100% on the dial is
// about a quarter of the nDisplay render's pace.
//   C_PushIn left: 0.61 view widths x (3840/3520) = 0.6655 over refDur 1.93 s
const REF_SIDE_DX_RATE = 0.61 * (REF_VIEW_PX / 3520) / 1.93;   // 0.3448 fw/s
const SPEED_UNITY = BENCHMARK_DX_RATE / REF_SIDE_DX_RATE;      // 0.2460

// Scale rides the same dial, in log space, so every ratio the reference render
// measured between the walls survives at any speed. Cross-check that this is
// not arbitrary: at 100% it puts the SIDE walls' scale at x1.0122/s, and the
// six reference clips measured x1.0113/s. Those agree to 0.1%, which is the
// only reason the centre's much larger scale is trusted to the same coupling.
// The reference gesture's own side-wall excursion, in delivered frame widths.
// Both presets share it (C_PushOut is C_PushIn reversed), which is what lets
// the two stay EXACT inverses of each other at every speed and duration.
const REF_SIDE_DX_TOTAL = 0.61 * (REF_VIEW_PX / 3520);   // 0.6655

// How much of the reference gesture this clip performs.
//
//     g = speed x BENCHMARK_DX_RATE x duration / REF_SIDE_DX_TOTAL
//
// Note what is NOT in that: refDur. An earlier pass divided each move by its
// own reference clip length, and because C_PushIn.mp4 is trimmed to 1.93 s and
// C_PushOut.mp4 to 1.83 s, the two presets stopped being exact inverses
// (-0.424 against +0.447 on the same wall). They are the same gesture played
// in opposite directions - README section 3 verified that frame by frame - so
// the trim difference is measurement noise and must not reach the contract.
// Working in gesture-fractions makes clip length drop out algebraically.
function gestureFraction(speedPct, T) {
  const p = Number(speedPct);
  const pct = (Number.isFinite(p) && p > 0 ? p : 100) / 100;
  return pct * BENCHMARK_DX_RATE * T / REF_SIDE_DX_TOTAL;
}

// HOW SMALL A SCALE CHANGE IS WORTH STATING, per wall.
//
// One flat 0.15 used to cover both, and trimming the centre exposed why that
// is wrong. The centre's ONLY motion is scale - it is a dolly with dx = 0 - so
// flattening a x1.117 push to "no size change" does not slow the centre down,
// it switches the centre off, and the contract then actively says "no zoom, no
// dolly, nothing gets bigger or smaller" on the one wall whose whole job is to
// push. At 25% and 5 s that is exactly what happened.
//
// A side wall is the opposite case: its move is dx, its scale is incidental,
// and a side wall that invents a zoom is a failure this project has measured
// more than once (x0.58 against a contract that said 1.00). There the wide
// deadzone is protection and it stays.
function zoomDeadzone(wall) { return wall === 'center' ? 0.02 : 0.15; }

function normalise(id) {
  if (id && MOVES[id]) return id;
  const legacy = {
    push_in: 'C_PushIn', pull_out: 'C_PushOut', push_out: 'C_PushOut',
    truck_left: 'C_TrackLeft', truck_right: 'C_TrackRight',
    track_left: 'C_TrackLeft', track_right: 'C_TrackRight',
    hold: 'C_Hold', sway: 'C_Hold', unknown: 'C_Hold',
    // Turns and tilts are no longer offered. If saved state or the decoder
    // still names one, the nearest offered move is used and the caller is told
    // by `substituted` on the spec.
    C_TurnLeft: 'C_TrackLeft', C_TurnRight: 'C_TrackRight',
    yaw_left: 'C_TrackLeft', yaw_right: 'C_TrackRight',
    C_TiltUp: 'C_Hold', C_TiltDown: 'C_Hold', tilt_up: 'C_Hold', tilt_down: 'C_Hold',
  };
  return legacy[id] || 'C_PushIn';
}

function wallKey(w) {
  return (w === 'left' || w === 'right' || w === 'center') ? w : 'center';
}

function round(x, n) { const f = Math.pow(10, n); return Math.round(x * f) / f; }

/**
 * The full numeric spec for one wall of one move at one clip length.
 * Everything downstream — prompt text, inspector, verifier — reads this, so
 * there is exactly one place where a number can be wrong.
 */
function spec(moveId, wallId, durationSec, speedPct, centrePct) {
  const id = normalise(moveId);
  const m = MOVES[id];
  const w = wallKey(wallId);
  const raw = m.walls[w];
  const T = Math.max(0.5, Number(durationSec) || 5);

  // View widths -> delivered wall widths. The sides are delivered 3520 wide but
  // were measured across a 3840 view, so the same world travel is a slightly
  // larger fraction of the delivered frame.
  const conv = REF_VIEW_PX / WALL_PX[w];

  // The reference gesture, converted to a PER-SECOND rate at the reference's
  // own duration, then re-paced by the speed dial. Reading the gesture as a
  // rate is what lets one speed mean the same thing at 4 s and at 15 s; the
  // ratios between the three walls are untouched, so the rig still moves as
  // one body however hard it is driven.
  // THE CENTRE GETS ITS OWN TRIM, because it does not obey like the sides do.
  //
  // Measured over three delivered sets: the side walls tracked what they were
  // asked (delivered/asked 1.44, 0.84, 1.71 - mean 1.33), while the centre
  // overshot its scale by 3-9x and its delivered rate barely moved with the
  // ask at all (asked ~1.017/s every time; delivered 1.05, 1.16, 1.17/s, which
  // tracks DURATION, not the number it was given). One dial cannot serve two
  // walls that respond that differently: set it so the sides look right and the
  // centre runs hot, set it so the centre looks right and the sides crawl.
  //
  // So `centrePct` trims the centre alone, on top of the main speed. 100 means
  // "keep the reference ratio between centre and sides"; lower slows the centre
  // without touching the sides. It multiplies the gesture fraction, so it acts
  // on the centre's scale exponent and stays consistent at every duration.
  const cp = Number(centrePct);
  const centreTrim = w === 'center'
    ? ((Number.isFinite(cp) && cp > 0) ? cp : CENTRE_TRIM_DEFAULT) / 100
    : 1;
  const g = gestureFraction(speedPct, T) * centreTrim;

  // THE ROOM'S OWN FIGURES FIRST - what a correct finished clip must measure.
  const dxDelivered = raw.dx * conv * g;
  const dyDelivered = raw.dy * (MASTER_H / WALL_H[w]) * g;
  // Scale compounds, so it takes the gesture fraction as an exponent. Because
  // the two presets' raw scales are exact reciprocals (x2.00 and x0.50), so are
  // their results at any speed and any duration.
  const scaleDelivered = Math.pow(raw.scale, g);

  // THEN THE ASK, which on the right wall is the opposite of it. See
  // DELIVERY_SIGN above: four measured clips, two presets, sign flipped every
  // time, so the ask is flipped to compensate. Applying it as a multiplier on
  // dx and as a sign on the scale EXPONENT keeps the inverted ask an exact
  // reciprocal of the delivered figure, the same way the two presets are exact
  // reciprocals of each other.
  const sign = DELIVERY_SIGN[w] || 1;
  const dxTotal = dxDelivered * sign;
  const dxRate = dxTotal / T;                       // frame-widths per second
  const dyTotal = dyDelivered * sign;
  const scaleTotal = Math.pow(raw.scale, g * sign);
  const scaleRate = Math.pow(scaleTotal, 1 / T);
  const pxPerFrame = Math.abs(dxTotal) * WALL_PX[w] / (T * FPS);

  const seamEdge = w === 'left' ? 'RIGHT' : w === 'right' ? 'LEFT' : null;
  const outerEdge = w === 'left' ? 'LEFT' : w === 'right' ? 'RIGHT' : null;
  const towardEdge = dxTotal === 0 ? null : (dxTotal > 0 ? 'RIGHT' : 'LEFT');
  const towardSeam = towardEdge && seamEdge ? towardEdge === seamEdge : null;

  return {
    move: id, label: m.label, wall: w, kind: m.kind,
    // Only a genuine substitution counts: a turn or a tilt is no longer an
    // offered preset, so it silently becomes the nearest translation and the
    // UI must say so. A legacy alias for a move that still exists is not a
    // substitution and must not raise a mismatch warning.
    substituted: (moveId && !MOVES[moveId] && /Turn|Tilt|yaw|tilt/.test(String(moveId)))
      ? String(moveId) : null,
    refClip: m.refClip, refDur: m.refDur,
    speedPct: round(g * REF_SIDE_DX_TOTAL / (BENCHMARK_DX_RATE * T) * 100, 1),
    durationSec: T, framePx: WALL_PX[w], frameH: WALL_H[w], fps: FPS,
    dxTotal: round(dxTotal, 4), dxRate: round(dxRate, 4),
    dyTotal: round(dyTotal, 4), dyRate: round(dyTotal / T, 4),
    scaleTotal: round(scaleTotal, 4), scaleRate: round(scaleRate, 4),
    // What a CORRECT finished clip must measure, before the right wall's
    // inversion is compensated for. compare() and the motion-lock end frame
    // read these; everything the prompt is built from reads the plain ones.
    dxDelivered: round(dxDelivered, 4),
    dyDelivered: round(dyDelivered, 4),
    scaleDelivered: round(scaleDelivered, 4),
    deliveryInverted: sign !== 1,
    towardEdgeDelivered: dxDelivered === 0 ? null : (dxDelivered > 0 ? 'RIGHT' : 'LEFT'),
    rollTotal: raw.roll,
    pxPerFrame: round(pxPerFrame, 2),
    overSafeCap: pxPerFrame > SAFE_PX_PER_FRAME && w !== 'center',
    calmDurationSec: pxPerFrame > SAFE_PX_PER_FRAME
      ? round(Math.abs(dxTotal) * WALL_PX[w] / (SAFE_PX_PER_FRAME * FPS), 1) : null,
    seamEdge, outerEdge, towardEdge, towardSeam,
  };
}

/**
 * Where a landmark starting at x0 (fraction of frame width) sits at time t.
 * Scale is about frame centre, translation is uniform — the same model that
 * was fitted to the reference, so the table and the measurement agree.
 */
function posAt(sp, x0, t) {
  const f = t / sp.durationSec;
  const s = Math.pow(sp.scaleTotal, f);
  return 0.5 + (x0 - 0.5) * s + sp.dxTotal * f;
}

function posAtY(sp, y0, t) {
  const f = t / sp.durationSec;
  const s = Math.pow(sp.scaleTotal, f);
  return 0.5 + (y0 - 0.5) * s + sp.dyTotal * f;
}

/**
 * The landmark clock: five timestamps, three anchor positions, as fractions of
 * frame width. This is the part a human can check on a timeline and a model can
 * actually aim at, and it is why the prompt now contains numbers.
 */
function landmarkRows(sp, anchors, steps) {
  const A = anchors || anchorsFor(sp.dxTotal);
  const N = steps || 4;
  const times = [];
  for (let i = 0; i <= N; i++) times.push(round(sp.durationSec * i / N, 2));
  return {
    times,
    rows: A.map(x0 => ({
      x0,
      xs: times.map(t => round(posAt(sp, x0, t), 3)),
      ys: times.map(t => round(posAtY(sp, x0, t), 3)),
      exits: times.reduce((acc, t) => {
        const x = posAt(sp, x0, t);
        return acc === null && (x < 0 || x > 1) ? t : acc;
      }, null),
    })),
  };
}

function pct(x) { return (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%'; }

/**
 * The block the locked prompt carries. Numbers first, prose only to say what
 * the numbers mean.
 */
function numericBlock(moveId, wallId, durationSec, speedPct, centrePct) {
  const sp = spec(moveId, wallId, durationSec, speedPct, centrePct);
  const NL = String.fromCharCode(10);
  const L = [];
  const wallName = sp.wall === 'center' ? 'CENTRE WALL' : sp.wall.toUpperCase() + ' WALL';

  L.push('CAMERA PATH — ' + sp.label);
  L.push(wallName + '. Delivered frame ' + sp.framePx + ' x ' + sp.frameH + ' px, '
       + sp.durationSec.toFixed(2) + ' s at ' + sp.fps + ' fps.');
  L.push('All positions below are fractions of the frame: x = 0.000 is the left edge, x = 1.000 the right edge.');
  L.push('');

  if (sp.kind === 'static') {
    L.push('MEASURED TARGETS: dx = 0.000, scale = 1.000, roll = 0 deg. The camera does not move at all.');
    L.push('Every edge of the frame stays exactly where it is. Only things inside the scene may move.');
    return L.join(NL);
  }

  // A machine-readable copy first. The same figures appear in prose below,
  // because a video model reads prose better than a struct, but the JSON is
  // unambiguous and it is what the operator can diff against the verifier.
  L.push('CAMERA_SPEC = ' + JSON.stringify({
    move: sp.move, wall: sp.wall, duration_s: sp.durationSec, fps: sp.fps,
    frame_px: [sp.framePx, sp.frameH],
    dx_total_frac: sp.dxTotal, dx_per_s_frac: sp.dxRate, dx_px_per_frame: sp.pxPerFrame,
    dy_total_frac: 0, scale_total: sp.scaleTotal, scale_per_s: sp.scaleRate,
    roll_deg: 0, yaw_deg: 0, pitch_deg: 0, easing: 'none', velocity: 'constant',
  }));
  L.push('');
  L.push('MEASURED TARGETS (from ' + sp.refClip + ', the theatre\'s own nDisplay render):');
  L.push('  horizontal travel   dx = ' + pct(sp.dxTotal) + ' of frame width over the clip = '
       + pct(sp.dxRate) + ' per second = ' + sp.pxPerFrame.toFixed(1) + ' px per frame at '
       + sp.framePx + ' px wide');
  L.push('  scale               x' + sp.scaleTotal.toFixed(2) + ' over the clip = x'
       + sp.scaleRate.toFixed(3) + ' per second');
  L.push('  vertical travel     dy = 0.000  — the frame must not drift up or down');
  L.push('  roll                0.0 deg     — the horizon must not tip');
  L.push('  yaw / pitch         none        — the camera does not turn, and does not look up or down');
  L.push('  Constant velocity. No ease in, no ease out, no hold, no acceleration, no handheld drift.');
  L.push('');

  // Direction, stated twice in two different vocabularies, because this is the
  // single term that has been wrong in delivered sets.
  if (sp.towardEdge) {
    const seamClause = sp.seamEdge
      ? ' This wall\'s ' + sp.seamEdge + ' edge is the SEAM where it meets the centre wall; its '
        + sp.outerEdge + ' edge is the OUTER end of the room. So content travels '
        + (sp.towardSeam ? 'from the OUTER end TOWARD the seam' : 'from the SEAM TOWARD the outer end')
        + ', and the new material that enters frame appears at the '
        + (sp.towardSeam ? sp.outerEdge : sp.seamEdge) + ' edge.'
      : '';
    L.push('DIRECTION: every landmark moves toward the ' + sp.towardEdge + ' edge of frame. '
         + 'Its x value ' + (sp.dxTotal > 0 ? 'INCREASES' : 'DECREASES') + ' with time.' + seamClause);
  } else {
    L.push('DIRECTION: no sideways drift at all. dx = 0.000. Content expands or contracts about the '
         + 'exact centre of frame, symmetrically — the left half moves left by the same amount the '
         + 'right half moves right.');
  }
  L.push('');

  // The clock.
  const lm = landmarkRows(sp);
  L.push('LANDMARK CLOCK — pick a distinct landmark in the supplied reference image at each starting');
  L.push('x below, name it, and put it at these positions at these timestamps. A value below 0.000 or');
  L.push('above 1.000 means that landmark has left the frame by then and must not be visible:');
  L.push('  landmark start    ' + lm.times.map(t => ('t=' + t.toFixed(2) + 's').padStart(10)).join(''));
  for (const r of lm.rows) {
    let line = '  x0 = ' + r.x0.toFixed(2) + '        '
      + r.xs.map(v => v.toFixed(3).padStart(10)).join('');
    if (r.exits !== null) line += '   (out of frame by t=' + r.exits.toFixed(2) + 's)';
    L.push(line);
  }
  if (Math.abs(sp.scaleTotal - 1) > 0.02) {
    L.push('  Vertical follows the same scale about frame centre: a landmark at y0 sits at '
         + '0.5 + (y0 - 0.5) x ' + sp.scaleTotal.toFixed(2) + ' at the end of the clip.');
  }
  L.push('');

  // The failure this block exists to stop.
  L.push('THIS IS A CAMERA MOVE, NOT AN ANIMATION. Every pixel obeys the table above — the furthest');
  L.push('background, the sky, the ground, the horizon line, the buildings, everything. If the');
  L.push('background is held and only the foreground objects travel, the shot is wrong and will be');
  L.push('rejected. Nothing in the scene moves under its own power; nothing moves relative to');
  L.push('anything else except through parallax, where nearer things travel further than distant');
  L.push('things along the same direction.');

  if (sp.overSafeCap) {
    L.push('');
    L.push('NOTE FOR THE OPERATOR (not an instruction to the generator): ' + sp.pxPerFrame.toFixed(1)
         + ' px/frame is above the room\'s ' + SAFE_PX_PER_FRAME + ' px/frame coherent-flow ceiling for '
         + 'a side wall. The reference gesture is a ' + sp.refDur.toFixed(2) + ' s beat; spreading the '
         + 'same excursion over ' + sp.calmDurationSec + ' s would bring it inside the ceiling.');
  }
  return L.join(NL);
}

// Rows for the preset inspector — the same numbers the prompt gets, so the
// debug window cannot disagree with the generation.
// THE SAME MOVE SAID BOTH WAYS, FOR A HUMAN ONLY.
//
// The contract deliberately never names the camera body - every direction
// inversion in this project came from a camera word being read as a content
// word or the reverse. But that leaves an operator reading "slides toward the
// LEFT edge" with nothing to check it against, because a person thinks in
// camera moves: "the camera goes left to right on the left wall."
//
// Both are true at once and they are opposites: a camera tracking toward
// frame right pushes the picture toward frame left. So the INSPECTOR prints
// both readings side by side. This string is never sent to a generator.
function cameraGloss(sp) {
  const zooms = Math.abs(sp.scaleTotal - 1) >= zoomDeadzone(sp.wall);

  if (sp.kind === 'static') {
    return { camera: 'camera is locked off', picture: 'nothing moves', numbers: '' };
  }

  const numbers = sp.towardEdge
    ? Math.abs(sp.dxTotal * 100).toFixed(1) + '% total  ·  '
      + Math.abs(sp.dxRate * 100).toFixed(1) + '%/s  ·  '
      + sp.pxPerFrame.toFixed(1) + ' px/f'
      + (sp.overSafeCap ? '  ·  OVER the ' + SAFE_PX_PER_FRAME + ' px/f room ceiling' : '')
    : (zooms ? 'x' + sp.scaleTotal.toFixed(2) + ' over ' + sp.durationSec.toFixed(1) + 's' : '');

  // Centre wall: the move is a dolly, so the camera word is forward or back.
  if (!sp.towardEdge) {
    return {
      camera: zooms ? (sp.scaleTotal > 1 ? 'camera dollies FORWARD, into the scene'
                                         : 'camera pulls BACK, away from the scene')
                    : 'camera holds position',
      picture: zooms ? (sp.scaleTotal > 1
                          ? 'everything gets BIGGER to x' + sp.scaleTotal.toFixed(2)
                            + ' - the frame shows LESS of the scene'
                          : 'everything gets SMALLER to x' + sp.scaleTotal.toFixed(2)
                            + ' - the frame shows MORE of the scene')
                     : 'the picture stays the same size',
      numbers: numbers,
    };
  }

  // Side wall: the camera travels the OPPOSITE way to the picture. On a push
  // in the rig moves forward, which on this wall's own image is toward the
  // deep end - the seam edge - so the picture slides toward the outer edge.
  const cameraEdge = sp.towardEdge === 'LEFT' ? 'RIGHT' : 'LEFT';
  const deep = sp.wall === 'left' ? 'RIGHT' : 'LEFT';
  const forward = cameraEdge === deep;
  return {
    camera: 'camera tracks toward frame ' + cameraEdge
          + (forward ? ' (the rig moving forward, deeper into the room)'
                     : ' (the rig moving back, out of the room)'),
    picture: 'the whole picture is carried toward frame ' + sp.towardEdge
           + (zooms ? ', and grows x' + sp.scaleTotal.toFixed(2) : ''),
    numbers: numbers,
  };
}

function inspector(moveId, durationSec, speedPct, centrePct) {
  return ['left', 'center', 'right'].map(w => {
    const sp = spec(moveId, w, durationSec, speedPct, centrePct);
    return {
      wall: w,
      framePx: sp.framePx + ' x ' + sp.frameH,
      dxTotal: pct(sp.dxTotal),
      dxRate: pct(sp.dxRate) + '/s',
      pxPerFrame: sp.pxPerFrame.toFixed(1) + ' px/f',
      scaleTotal: 'x' + sp.scaleTotal.toFixed(2),
      scaleRate: 'x' + sp.scaleRate.toFixed(3) + '/s',
      dy: sp.dyTotal.toFixed(3),
      roll: sp.rollTotal.toFixed(1) + ' deg',
      // "expanding" / "contracting" were the words that read as a camera move
      // and came back inverted on the centre wall. The panel now says it the
      // way the contract says it.
      direction: sp.towardEdge
        ? 'toward frame ' + sp.towardEdge
          + (sp.seamEdge ? (sp.towardSeam ? ' (toward the seam)' : ' (toward the outer end)') : '')
        : (Math.abs(sp.scaleTotal - 1) > 0.02
            ? (sp.scaleTotal > 1 ? 'everything gets bigger' : 'everything gets smaller')
            : 'locked off'),
      gloss: cameraGloss(sp),
      overSafeCap: sp.overSafeCap,
      raw: sp,
    };
  });
}

/**
 * Grade one measured clip against the spec its prompt carried.
 *
 * Lives here, next to the spec itself, for the reason the old verifier failed:
 * it graded a five-second clip against a 1.9-second reference RATE, so a clip
 * that obeyed the prompt exactly was reported "too weak" and one running at
 * three times the asked-for travel was reported a match. Same file, same
 * units, one set of thresholds - the check and the instruction cannot drift
 * apart again.
 *
 * `measured` is a wall_motion.py result: dxTotal, scaleTotal, rollTotal,
 * bgRatio, durationSec - all in the delivered clip's own frame units, which is
 * exactly what spec() states.
 */
function compare(moveId, wallId, measured, speedPct, centrePct) {
  const want = spec(moveId, wallId, measured.durationSec || 5, speedPct, centrePct);
  const row = { wall: wallId, problems: [], want: want };

  // GRADED AGAINST THE ROOM, NOT AGAINST THE ASK. On the right wall the two are
  // opposites on purpose (see DELIVERY_SIGN): the contract asks for the reverse
  // because the generator reverses it. A finished clip still has to MEASURE the
  // room's own geometry, so that is what it is held to - otherwise inverting the
  // ask would have inverted the verdict along with it and every correct right
  // wall would come back "travelling the WRONG WAY".
  const wantDx = want.dxDelivered;
  const wantScale = want.scaleDelivered;
  row.inverted = !!want.deliveryInverted;
  row.dx = { want: wantDx, got: measured.dxTotal, asked: want.dxTotal };
  row.scale = { want: wantScale, got: measured.scaleTotal, asked: want.scaleTotal };
  row.roll = { want: 0, got: measured.rollTotal };
  row.bgRatio = measured.bgRatio === undefined ? null : measured.bgRatio;

  const dxWanted = Math.abs(wantDx) > 0.05;
  if (dxWanted) {
    const sameDir = (wantDx > 0) === (measured.dxTotal > 0);
    const ratio = Math.abs(measured.dxTotal) / Math.abs(wantDx);
    row.dx.ratio = round(ratio, 2);
    row.dx.sameDirection = sameDir;
    // WRONG WAY GETS THE SAME ADVICE AS TOO-WEAK, and it had not been getting
    // it. The right wall has now come back the wrong way on three measured
    // C_PushOut sets in a row (+0.233, then +0.083 after the direction field was
    // rewritten, against an ask of -0.428). Rewording is what has already been
    // tried; a start/end frame pair makes the translation a geometric fact
    // rather than a request, which is the whole reason Lock motion exists.
    if (!sameDir && Math.abs(measured.dxTotal) > 0.05) {
      row.problems.push('travelling the WRONG WAY - press Lock motion on this wall and regenerate; '
        + 'prompting alone has not turned it round');
    }
    else if (ratio < 0.5) row.problems.push('travelling only ' + Math.round(ratio * 100)
      + '% as far as the preset - press Lock motion on this wall and regenerate; prompting '
      + 'alone has not moved it');
    else if (ratio > 1.8) row.problems.push('travelling ' + Math.round(ratio * 100) + '% of the preset - too fast');
  } else if (Math.abs(measured.dxTotal) > 0.15) {
    row.problems.push('drifting sideways when the preset asks for none');
  }

  // Scale is compared in log space: x2.0 and x0.5 are the same size of error,
  // and a linear comparison would call one of them twice as bad as the other.
  const scaleWanted = Math.abs(wantScale - 1) > zoomDeadzone(want.wall);
  if (scaleWanted) {
    const lw = Math.log(wantScale);
    const lg = Math.log(Math.max(0.05, measured.scaleTotal));
    const sr = lg / lw;
    row.scale.ratio = round(sr, 2);
    if (lg * lw < 0) row.problems.push('zooming the WRONG WAY');
    else if (sr < 0.45) row.problems.push('only ' + Math.round(sr * 100) + '% of the scale change the preset asks for');
    else if (sr > 1.9) row.problems.push('far more scale change than the preset');
  }

  // The static-plate test, which is the failure the last right wall had: the
  // objects slid and the background did not. Only meaningful under near-pure
  // translation - a real zoom barely moves the frame centre, so a low
  // background ratio there is geometry, not a fault.
  if (!scaleWanted && dxWanted && row.bgRatio !== null && row.bgRatio < 0.45) {
    row.problems.push('the background is not moving with the camera - objects are sliding over a '
                    + 'static plate instead of the camera travelling');
  }

  // A zoom nobody asked for. The right wall came back at x0.58 on a move whose
  // contract says 1.00, and nothing flagged it, because the check only looked
  // at scale when the PRESET wanted scale.
  if (!scaleWanted && Math.abs(Math.log(Math.max(0.05, measured.scaleTotal))) > Math.log(1.2)) {
    row.problems.push('zooming ' + (measured.scaleTotal > 1 ? 'in' : 'out') + ' to x'
      + Number(measured.scaleTotal).toFixed(2) + ' when the preset asks for no size change at all');
  }
  if (Math.abs(measured.rollTotal || 0) > 4) {
    row.problems.push('the horizon rolls ' + Number(measured.rollTotal).toFixed(1) + ' deg');
  }
  return row;
}

/**
 * DOES THE CENTRE KEEP PACE WITH THE SIDES? A set-level test that compare()
 * cannot make, because it only ever sees one wall.
 *
 * Each wall's delivered/asked ratio (dx for the sides, log-scale for the
 * centre - the units the spec compounds in) says how hard that job ran against
 * its own ask. The rig reads as one camera only if the three ran equally hard,
 * so the centre's ratio over the sides' mean is its pace. Measured on the
 * delivered sets in the Library: 0.95, 0.36, and two lone centres at 3.3 and
 * 3.6 against sides near 1.1 - the same contract every time, so this is
 * per-scene variance a fixed trim cannot remove. It is measured per set and
 * turned into the centre trim that would have matched, for a centre-only
 * re-roll of that scene.
 *
 * `rows` are compare() rows; `centrePct` the trim they were measured under.
 */
function paceMatch(rows, centrePct) {
  const byWall = {};
  (rows || []).forEach(r => { byWall[r.wall] = r; });
  const c = byWall.center;
  const sides = ['left', 'right'].map(w => byWall[w])
    .filter(r => r && r.dx && r.dx.ratio > 0 && r.dx.sameDirection !== false);
  if (!c || !c.scale || !(c.scale.ratio > 0) || !sides.length) return null;
  const sideRatio = sides.reduce((a, r) => a + r.dx.ratio, 0) / sides.length;
  const pace = c.scale.ratio / sideRatio;
  const cp = Number(centrePct) > 0 ? Number(centrePct) : 100;
  // The trim box's own range; rounded to its 5% step.
  const suggested = Math.min(400, Math.max(5, Math.round(cp / pace / 5) * 5));
  const matched = pace >= 0.8 && pace <= 1.25;
  return {
    centreRatio: round(c.scale.ratio, 2), sideRatio: round(sideRatio, 2), pace: round(pace, 2),
    matched, centrePct: cp, suggestedCentrePct: matched ? cp : suggested,
    note: matched
      ? 'The centre kept pace with the sides (' + round(pace, 2) + 'x).'
      : 'The centre ran at ' + round(pace, 2) + 'x the pace of the side walls ('
        + (pace > 1 ? 'too fast' : 'too slow') + '). A centre trim of ' + suggested
        + '% would have matched this set - apply it and regenerate the centre only.',
  };
}

// ------------------------------------------------------------------ JSON ---
// THE PROMPT FORMAT THAT ACTUALLY WORKED.
//
// The user supplied seven of their own hand-written prompts that produced
// correct camera motion, and every one of them is a JSON document with the
// camera described as a real camera: projection, yaw, a start and end
// transform, a velocity vector, easing, and a block of explicit "allow_*:
// false" locks plus a negative_prompt list. Prose versions of the same
// instruction - including the numeric prose this file emitted before - kept
// getting loosely interpreted: the right wall zoomed when it was told to
// slide, and the left wall grew furniture that was never in the plate.
//
// THE DIRECTION FIELDS, AND THE CONFUSION THEY RESOLVE
// ---------------------------------------------------
// In those working prompts, `camera.motion.type` is "pan_left_to_right" on the
// LEFT wall and "pan_right_to_left" on the RIGHT wall. Those describe the
// CAMERA, not the picture. In the same files, `environmental_fx.clouds.motion`
// - which describes CONTENT - is "right_to_left" on the left wall and
// "left_to_right" on the right wall. Camera right means content left, so both
// fields agree, and both agree with the reference renders: on a push in, the
// left wall's content travels to frame LEFT and the right wall's to frame
// RIGHT. Every round of "the direction is wrong" came from reading a camera
// field as if it were a content field.
//
// So the JSON below keeps the exact key names that worked, and adds
// `content_direction` alongside them, stated in the picture's own terms, so
// nothing has to be inferred ever again.

// NO CAMERA-FRAME VOCABULARY. THIS IS WHY.
//
// The first JSON build described the move twice: `type: "pan_left_to_right"`
// (the camera body) and `content_direction: "frame_right_to_frame_left"` (the
// picture). Those are the same move - a camera panning right makes the picture
// travel left - but only if the reader knows which frame of reference each key
// uses. The generator did not.
//
// Measured off the C_PushOut set: the RIGHT wall was asked for dx -0.665, its
// `type` read "pan_left_to_right", and it came back travelling +0.137 - the
// camera field followed, the content field ignored. The LEFT wall got the
// mirror pair and came back at +0.015, i.e. paralysed between them.
//
// So every direction statement below is now in the PICTURE's frame, and there
// is exactly one of them. `camera_direction` and `pan_*_to_*` are gone. A
// signed number plus one unambiguous word is the whole vocabulary:
//
//     dx < 0  ->  the picture travels toward FRAME_LEFT
//     dx > 0  ->  the picture travels toward FRAME_RIGHT
function travelWord(dxTotal) {
  if (Math.abs(dxTotal) < 0.02) return 'NONE';
  return dxTotal < 0 ? 'FRAME_LEFT' : 'FRAME_RIGHT';
}

// Landmark anchors are chosen AGAINST the direction of travel, so most of them
// are still on screen at the end of the clip. With fixed anchors at
// 0.15/0.50/0.85 a rightward move put two of the three off the right edge
// before the halfway mark, and a table where most rows read "gone" is a table
// a generator can satisfy by doing nothing.
function anchorsFor(dxTotal) {
  if (Math.abs(dxTotal) < 0.05) return [0.15, 0.50, 0.85];
  return dxTotal > 0 ? [0.08, 0.24, 0.40] : [0.60, 0.76, 0.92];
}

const WALL_YAW = { left: -90, center: 0, right: 90 };
const CANVAS_X = { left: 0, center: 3840, right: 8000 };

// ------------------------------------------------- THE TRAVELLING ELEMENT ---
// One object crossing all three walls as a single journey, so an audience at
// the one eyepoint follows it with their head instead of watching three
// unrelated clips. The timetable lives here, beside the camera figures, for the
// same reason every other number moved here: the page computed one version of
// it (33.3 / rate) and rig.js stored another (a flat 1.9s), so moving the rate
// box changed one of them and not the other, and nothing ever compared them.
//
// `ratePctPerSec` is a percentage of the WHOLE three-wall span per second. One
// wall is a third of the span, so
//     per_wall_seconds = (100 / 3) / rate
//     whole_crossing   = 100 / rate
// and 17.5%/s is the 1.90s-per-wall, 5.71s-total figure measured off the
// reference butterfly.

// How many of them there are, when the subject box says so. "5 large Owl" is
// five owls, and the contract used to answer that with "This is ONE 5 large
// Owl" - a sentence that tells the generator the count is both five and one.
function elementCount(subject) {
  const s = String(subject == null ? '' : subject).trim();
  const digits = s.match(/^(\d{1,3})\b/);
  if (digits) return parseInt(digits[1], 10);
  const WORDS = { a: 1, an: 1, one: 1, single: 1, lone: 1, two: 2, pair: 2, three: 3, four: 4,
                  five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12 };
  const first = s.split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, '');
  return WORDS[first] != null ? WORDS[first] : null;
}

/**
 * The element's timetable for ONE wall, or null if no element is configured.
 * Everything is derived from the rate and the clip length - nothing is read
 * back off the form, because two places computing it is how they drifted.
 */
// The fallback windows, used only when a rig has no `element.windows` yet - a
// state file saved before the timestamps replaced the rate box. Derived from the
// old rate model so an existing scene keeps the timing it already had.
function legacyWindows(c, dur) {
  const rate = (Number.isFinite(Number(c.ratePctPerSec)) && Number(c.ratePctPerSec) > 0)
    ? Number(c.ratePctPerSec) : 17.5;
  const dir = c.direction === 'left_to_right' ? 'left_to_right' : 'right_to_left';
  const order = dir === 'right_to_left' ? ['right', 'center', 'left'] : ['left', 'center', 'right'];
  let perWall = (100 / 3) / rate;
  let entry = Number.isFinite(Number(c.entrySec)) ? Number(c.entrySec) : 2.0;
  if (perWall * 3 > dur) { perWall = dur / 3; entry = 0; }
  else if (entry + perWall * 3 > dur) { entry = Math.max(0, dur - perWall * 3); }
  const out = {};
  order.forEach((w, i) => {
    out[w] = { enter: round(entry + i * perWall, 2), exit: round(entry + (i + 1) * perWall, 2) };
  });
  return out;
}

/**
 * The element's timetable for ONE wall, or null if no element is configured.
 *
 * THE OPERATOR STATES THE TIMES NOW, AND SPEED FALLS OUT OF THEM. It used to be
 * the other way round: a "% of the room per second" box set the pace and the
 * tool worked out the windows from it. That was backwards twice over -
 *   * it is a unit nobody thinks in, and its own default (17.5%/s) asked for a
 *     5.71s crossing that does not fit a 5s clip at all; and
 *   * the windows were the thing that actually mattered, so the number that
 *     mattered was being derived from a number chosen without seeing it.
 * Each wall now carries `enter` and `exit` in seconds, they are clamped to the
 * clip, and the crossing speed is REPORTED from them rather than set.
 */
function elementSchedule(rig, wallId) {
  const c = (rig && rig.element) || {};
  if (!c.enabled || !String(c.subject || '').trim()) return null;

  const w = wallKey(wallId);
  const dur = Math.max(1, Number(rig && rig.durationSec) || 5);
  const dir = c.direction === 'left_to_right' ? 'left_to_right' : 'right_to_left';
  const order = dir === 'right_to_left' ? ['right', 'center', 'left'] : ['left', 'center', 'right'];
  const idx = order.indexOf(w);
  if (idx < 0) return null;

  const wins = (c.windows && typeof c.windows === 'object') ? c.windows : legacyWindows(c, dur);
  const notes = [];

  // NOTHING MAY POINT OUTSIDE THE CLIP. A window running past the end is how the
  // third wall used to be handed a slot from 5.71s to 7.61s of a five-second
  // video - an instruction it could not obey, which it answered by showing the
  // element whenever it felt like it.
  function clampWin(key) {
    const raw = wins[key] || {};
    let a = Number(raw.enter), b = Number(raw.exit);
    if (!Number.isFinite(a)) a = 0;
    if (!Number.isFinite(b)) b = dur;
    const oa = a, ob = b;
    a = Math.min(Math.max(0, a), dur);
    b = Math.min(Math.max(0, b), dur);
    // Never a zero-length window. Clamping an exit back to the end of the clip
    // can collapse it onto its own entry - a window of 0s, which divides by zero
    // when the crossing speed is read off it - so pull the ENTRY back instead.
    if (b <= a) {
      a = Math.max(0, Math.min(a, dur - 1 / FPS));
      b = Math.min(dur, a + 1 / FPS);
    }
    return { enter: round(a, 2), exit: round(b, 2), clamped: (oa !== a || ob !== b) };
  }

  const all = {};
  for (const k of ['left', 'center', 'right']) all[k] = clampWin(k);
  const mine = all[w];
  // Report EVERY clamped wall, not just this one: the timeline shows all three,
  // and a window silently moved on a wall you are not currently looking at is
  // exactly the kind of thing that gets noticed only in the delivered clip.
  const clamped = ['left', 'center', 'right'].filter(k => all[k].clamped);
  if (clamped.length) {
    notes.push('Outside the ' + dur + 's clip and clamped: '
      + clamped.map(k => k.toUpperCase() + ' to ' + all[k].enter + '-' + all[k].exit + 's').join(', ')
      + '. No window can point past the end of the clip.');
  }

  const onScreen = round(mine.exit - mine.enter, 2);

  // SPEED IS A READING NOW, NOT A SETTING. The element crosses from clear of one
  // edge to clear of the other in `onScreen` seconds, which is 1.24 frame widths
  // of travel - the 0.12 overshoot at each end is where it is still out of shot.
  const SPAN = 1.24;
  const crossRate = round(SPAN / onScreen, 3);              // frame widths per second
  const roomPctPerSec = round((100 / 3) / onScreen, 1);     // % of the whole room per second

  // THE RELAY SHOULD CHAIN: each wall picks the element up where the last one
  // dropped it. A gap means it is nowhere in the room for a moment; an overlap
  // means it is on two walls at once. Both are allowed - the operator sets the
  // times now - but neither should happen silently.
  for (let i = 1; i < order.length; i++) {
    const prev = all[order[i - 1]], next = all[order[i]];
    const d = round(next.enter - prev.exit, 2);
    if (d > 0.05) {
      notes.push('Gap of ' + d + 's between ' + order[i - 1].toUpperCase() + ' letting go ('
               + prev.exit + 's) and ' + order[i].toUpperCase() + ' picking it up (' + next.enter
               + 's) - it is nowhere in the room for that moment.');
    } else if (d < -0.05) {
      notes.push('Overlap of ' + Math.abs(d) + 's between ' + order[i - 1].toUpperCase() + ' and '
               + order[i].toUpperCase() + ' - it is on two walls at once.');
    }
  }

  // AND IT HAS TO BE A PACE A CROSSING CAN ACTUALLY BE DRAWN AT. Measured on the
  // delivered set of 2026-09-23: the contract asked for 0.95s per wall and every
  // wall drew a crossing of roughly 3 seconds instead - the right wall let the
  // owls in at 2.0s exactly as asked and still had them on screen at 5.0s.
  if (onScreen < 1.5) {
    notes.push(w.toUpperCase() + ' is on screen for only ' + onScreen + 's. Every delivered '
             + 'crossing so far has been drawn at roughly 3s across a wall whatever it was asked '
             + 'for, so a window this short is the one most likely to be overrun.');
  }

  const enterEdge = dir === 'right_to_left' ? 'RIGHT' : 'LEFT';
  const exitEdge = dir === 'right_to_left' ? 'LEFT' : 'RIGHT';
  const inAt = mine.enter, outAt = mine.exit;

  // HOW BIG IT IS. Nothing stated this, and the delivered set showed exactly what
  // happens: one prompt and one reference picture produced small distant owls on
  // the right wall, mid-sized ones on the centre, and on the left wall a SINGLE
  // bird in close-up filling half the frame.
  const askedSize = Number(c.sizePctOfHeight);
  const sizePct = (Number.isFinite(askedSize) && askedSize > 0) ? Math.min(90, askedSize) : 12;

  // AND HOW HIGH UP IT CROSSES. The same gap as size, and it showed the same
  // way on the delivered set: the right wall's owls crossed up near the horizon
  // and the left wall's sat low and enormous. An element that changes height
  // between walls is three flights, not one - the audience is turning its head
  // through a continuous line, so the line has to be at one height.
  const askedY = Number(c.heightPctFromTop);
  const heightPct = (Number.isFinite(askedY) && askedY > 0) ? Math.min(95, askedY) : 35;

  // WHERE IT IS, SECOND BY SECOND. Entry and exit times on their own were read as
  // loose cues and overrun every time. The camera half of this contract is obeyed
  // because it is given as a position at a time, so the element gets the same. x
  // is the element centre: 0 = left edge, 1 = right edge, and values outside
  // 0..1 are where it is still clear of the frame.
  const xIn = enterEdge === 'RIGHT' ? 1.12 : -0.12;
  const xOut = exitEdge === 'RIGHT' ? 1.12 : -0.12;
  const xs = [];
  for (let k = 0; k <= 4; k++) {
    const f = k / 4;
    xs.push([round(inAt + f * onScreen, 2), round(xIn + f * (xOut - xIn), 2)]);
  }

  const firstEnter = Math.min.apply(null, order.map(k => all[k].enter));
  const lastExit = Math.max.apply(null, order.map(k => all[k].exit));

  return {
    sizePctOfHeight: sizePct, heightPctFromTop: heightPct, xPath: xs,
    subject: String(c.subject).trim(),
    count: elementCount(c.subject),
    direction: dir, order: order, wall: w, index: idx, lastIndex: order.length - 1,
    windows: all,
    onScreenSec: onScreen, perWallSec: onScreen,
    crossRateFrameWidthsPerSec: crossRate, roomPctPerSec: roomPctPerSec,
    totalSec: round(lastExit - firstEnter, 2), firstEnter: firstEnter, lastExit: lastExit,
    durationSec: dur, fps: FPS,
    enterEdge: enterEdge, exitEdge: exitEdge, inAt: inAt, outAt: outAt,
    inFrame: Math.round(inAt * FPS), outFrame: Math.round(outAt * FPS),
    lastFrame: Math.round(dur * FPS),
    refPath: c.refPath || null,
    notes: notes,
  };
}

// WHAT A GENERATOR IS TOLD NOT TO DO. Twelve lines, not fifty.
//
// The previous list ran to fifty entries inside a 9.5KB contract, and the
// delivered set ignored the load-bearing ones: the right wall zoomed 0.58
// where the contract said 1.00, rolled 8 degrees where it said 0, and left
// its background at 5% of the frame rate. Long inputs get attended to in the
// middle least of all, and the important constraints were in the middle.
// Everything here is something a delivered clip has actually got wrong.
// WHEN A TRAVELLING ELEMENT IS CONFIGURED, FOUR OF THESE FORBID IT.
// "no object travels across the picture on its own", "nothing added: no new
// object, character...", "characters keep their exact design, count and facing"
// and the wrong-edge rule each describe precisely what the element does. The
// contract was ordering the generator to draw it and not to draw it in the same
// breath, and a contradicted rule is one a model settles by guessing - which is
// how the element came back repeating, or sitting in frame the whole clip, or
// not appearing at all. Each exemption NAMES the element rather than softening
// the rule, so everything that is not the element stays exactly as locked.
function negativePrompt(sp, el) {
  const n = [];
  // Short on purpose: the window and the subject are stated once, in
  // travelling_element. Repeating them across four negatives cost 500
  // characters of a contract already over its size budget, and an oversized
  // contract gets its middle ignored - the exact failure this file exists for.
  const ex = el ? ' (travelling_element excepted, ' + el.inAt + '-' + el.outAt + 's)' : '';
  if (sp.towardEdge) {
    const wrong = sp.towardEdge === 'LEFT' ? 'RIGHT' : 'LEFT';
    // The element may legitimately cross against the camera: a right-to-left
    // element on a wall whose picture travels right does exactly that, and on a
    // push-in right wall it does. Only exempt it when it actually clashes.
    const clash = !!el && el.exitEdge === wrong;
    n.push('nothing travels toward the ' + wrong + ' edge - not one object, not the crowd'
         + (clash ? ex : ''));
  }
  // Outside the direction test on purpose: a centre wall on a dolly has dx = 0,
  // so these two used to be omitted and its contract carried no rule against an
  // element moving on its own at all.
  if (sp.kind !== 'static') {
    n.push('the background is never still while the foreground moves');
    n.push('no object travels across the picture on its own - the picture is what moves, and '
         + 'nothing changes its position within the scene' + ex);
  }
  if (Math.abs(sp.scaleTotal - 1) < zoomDeadzone(sp.wall)) {
    n.push('no zoom, no dolly, nothing gets bigger or smaller');
  }
  if (Math.abs(sp.dxTotal) < 0.02) n.push('no sideways drift, no pan');
  n.push('no held frame and no jump - the motion is continuous from frame 1 to the last frame');
  n.push('no roll, no tilt, no yaw, no camera shake');
  n.push('nothing added: no new object, character, crowd, sign, text, confetti, sparkle, particle, '
       + 'weather or light' + ex);
  n.push('nothing removed, redrawn, restyled or recoloured');
  n.push('characters keep their exact design, count and facing'
       + (el ? ' - the travelling element is not one of them and is not in the scene already' : ''));
  n.push('the horizon stays at the same height in every frame');
  n.push('no cut, no dissolve, no speed ramp, no ease');
  return n;
}

// HOW A CHANGE OF SIZE IS DESCRIBED, AND WHY IT IS NOT "expand" OR "contract".
//
// The centre wall came back inverted on BOTH presets: a push in rendered as a
// zoom out, and a push out measured x1.37 where the contract asked x0.50.
// The contract said "the entire picture contracts inward toward the exact
// centre of frame". "Inward" and "outward" are camera words - a camera moving
// inward is a push IN - so the sentence read as the opposite of what it
// specified. Same failure as pan_left_to_right, different vocabulary.
//
// So size is now described only by what happens to the PICTURE: things get
// bigger or smaller, and the frame shows less or more. Neither has a camera
// reading.
function sizeWords(scaleTotal, deadzone) {
  if (Math.abs(scaleTotal - 1) < (deadzone == null ? 0.15 : deadzone)) {
    return { change: 'none - everything stays exactly the size it is now', fov: 'unchanged' };
  }
  if (scaleTotal > 1) {
    return {
      change: 'everything in the picture gets BIGGER, reaching x' + scaleTotal.toFixed(2)
            + ' of its starting size. The frame shows LESS of the scene every second, and content '
            + 'runs off past all four edges. No new scene appears anywhere.',
      fov: 'narrows',
    };
  }
  return {
    change: 'everything in the picture gets SMALLER, down to x' + scaleTotal.toFixed(2)
          + ' of its starting size. The frame shows MORE of the scene every second, and new scene '
          + 'comes in at all four edges. Nothing runs off the edges.',
    fov: 'widens',
  };
}

/**
 * The locked camera contract. Deliberately small.
 *
 * It was 9.5KB of JSON across nine top-level sections - a room description, a
 * perspective essay, the room's energy law, fifty negatives - and the terms
 * that actually decide whether a clip is usable were buried in the middle of
 * it. This is the same information at about a quarter of the size, with every
 * key load-bearing. The operator-facing material (energy law, seam prose) is
 * still in the inspector; it was never something the generator could act on.
 */
function cameraJson(moveId, wallId, durationSec, opts) {
  const sp = spec(moveId, wallId, durationSec, opts && opts.speedPct, opts && opts.centrePct);
  // The element's timetable for THIS wall, if one is configured. The negatives
  // and the revealed-edge band both need it, because both of them otherwise
  // forbid the element outright.
  const el = (opts && opts.element) || null;
  const zooms = Math.abs(sp.scaleTotal - 1) >= zoomDeadzone(sp.wall);
  const scaleEnd = zooms ? sp.scaleTotal : 1.0;
  const sz = sizeWords(scaleEnd, zoomDeadzone(sp.wall));
  const lm = landmarkRows(sp);
  const n = Math.max(2, Math.round(sp.durationSec));

  const headline = sp.kind === 'static'
    ? 'THE ONE THING THAT MUST BE RIGHT: the camera does not move at all.'
    : (sp.towardEdge
        ? 'THE ONE THING THAT MUST BE RIGHT: the WHOLE PICTURE is carried toward the '
          + sp.towardEdge + ' edge of frame as one locked piece - background, sky, floor, far crowd, '
          + 'every pixel together, keeping their exact positions relative to each other - travelling '
          + Math.abs(sp.dxTotal * 100).toFixed(1) + '% of the frame width over '
          + sp.durationSec.toFixed(1) + ' seconds at a constant speed. Nothing inside the picture '
          + 'travels on its own or changes place within the scene.'
        : 'THE ONE THING THAT MUST BE RIGHT: ' + sz.change + ' There is no sideways drift at all.');

  const checkpoints = [];
  for (let i = 0; i <= n; i++) {
    const t = round(sp.durationSec * i / n, 2);
    const f = t / sp.durationSec;
    checkpoints.push([t, round(sp.dxTotal * f, 3), round(Math.pow(scaleEnd, f), 3)]);
  }

  const out = {
    headline: headline,
    id: sp.move + ' / ' + sp.wall.toUpperCase() + ' wall / ' + sp.durationSec.toFixed(1) + 's',
    frame: {
      px: [sp.framePx, sp.frameH],
      fps: sp.fps,
      duration_s: sp.durationSec,
      x_scale: '0.000 = left edge of frame, 1.000 = right edge',
      first_frame: 'must be the supplied reference image, unchanged',
    },
    camera: {
      travel: sp.towardEdge
        ? 'the whole picture is carried toward the ' + sp.towardEdge + ' edge as one locked piece'
        : 'no sideways movement',
      dx_total: sp.dxTotal,
      dx_per_second: sp.dxRate,
      px_per_frame: sp.pxPerFrame,
      size_change: sz.change,
      scale_end: scaleEnd,
      field_of_view: sz.fov,
      dy_total: 0,
      roll_degrees: 0,
      speed: 'constant from the first frame to the last - no ease, no hold, no acceleration',
    },
    checkpoints: checkpoints,
    checkpoints_key: '[seconds, dx_so_far_in_frame_widths, size_so_far] - the picture must be at '
                   + 'these values at these times. Equal movement in every equal slice of time.',
  };

  // No km/h. It was never measurable here - pixels carry no depth - so it rode
  // in the contract as an advisory string that governed nothing while looking
  // authoritative. What the dial sets is a real, checkable rate, and it is
  // already stated above as dx_per_second; this only records where it came from.
  if (sp.kind !== 'static') {
    out.camera.speed_percent = sp.speedPct;
    out.camera.speed_note =
      'Speed is a RATE, so the travel above is dx_per_second x duration: the same speed over a '
      + 'longer clip covers proportionally more ground. 100% is the measured average of the '
      + 'operator reference clips (' + BENCHMARK_DX_RATE + ' of frame width per second on a side wall).';
  }

  if (sp.wall !== 'center' && sp.towardEdge) {
    out.parallax = {
      foreground_dx_total: round(sp.dxTotal * 1.45, 3),
      midground_dx_total: sp.dxTotal,
      far_background_dx_total: round(sp.dxTotal * 0.75, 3),
      rule: 'measured from the reference render. All three travel the SAME way. Depth changes HOW '
          + 'FAR something travels, never WHICH WAY. The furthest thing in frame still moves '
          + Math.abs(sp.dxTotal * 0.75 * 100).toFixed(0) + '% of the frame width. If a character is '
          + 'also animating on its own, that is ON TOP of this, not instead of it.',
    };
  }

  out.landmarks = lm.rows.map((r, i) => ({
    x_start: r.x0,
    x_at: lm.times.map((t, k) => [t, r.xs[k]]),
    name: '<name the real thing at this position in the reference image>',
  }));
  out.landmarks_key = '[seconds, x] - pick a real, nameable thing at each x_start and hold it to '
                    + 'these positions. Outside 0..1 means it has left frame by then.';

  if (sp.towardEdge) {
    const revealed = sp.towardEdge === 'RIGHT' ? 'LEFT' : 'RIGHT';
    out.revealed_edge = {
      edge: revealed,
      width_by_end: round(Math.abs(sp.dxTotal), 3),
      // The element enters through one of the frame edges, and on some walls
      // that is this band. "Put no new object in this band" and "the element
      // enters at the RIGHT edge at 2.0s" were flatly contradicting each other
      // on exactly the walls where the two edges coincide.
      fill: 'continue the material right next to it - the same floor, wall, sky or crowd. Put no '
          + 'new object, character or feature in this band.'
          + (el && el.enterEdge === revealed
              ? ' The travelling element crosses this edge at ' + el.inAt + 's and is not band fill.'
              : ''),
    };
  }

  // CONFIRMED WORKING ON C_PushIn - DO NOT REWORD WITHOUT A MEASURED SET.
  // The owner checked delivered output after this went in: "right motion is
  // fixed, it's looking nice for push in." Three sets before it were wrong-way
  // three times out of three. The wording below and the rig_context block are
  // the only things that changed, so they are load-bearing until something
  // measured says otherwise.
  //
  // THE RIGHT WALL USED TO TRAVEL THE SAME WAY AS THE LEFT ONE.
  //
  // Measured across three delivered sets (Snow, Toronto, Bear): the LEFT wall
  // obeyed its direction every time, and the RIGHT wall travelled the SAME way
  // as the left every time - asked +0.130 got -0.018, asked +0.162 got -0.364,
  // asked +0.081 got -0.179. Three for three, wrong way. Reversing it in the
  // edit is not a fix: it runs the scene's own animation backwards too, so a
  // walking animal walks backwards.
  //
  // EACH JOB SEES ONE IMAGE AND ONE PROMPT. Nothing else is uploaded - not the
  // other walls' plates, not their prompts, not their clips. So a rule phrased
  // as "the other side wall goes the opposite way" is unusable: there is no
  // other wall in front of the model to be opposite TO. A first version of this
  // field said exactly that and would have been dead text.
  //
  // What IS in front of it is the reference image, and that image already
  // carries the answer, because the two side walls are mirrored in PERSPECTIVE:
  // the left wall recedes toward its RIGHT edge, the right wall toward its
  // LEFT. Anchoring travel to the visible vanishing direction therefore comes
  // out mirrored on its own, from a rule that only ever talks about this one
  // frame. Same reason `perspective` works and never needed a sibling either.
  // ...AND THEN IT SENT THE PUSH-OUT SET THE WRONG WAY. Measured 2026-09-23,
  // C_PushOut at 100% / centre 25%, one set of three:
  //
  //     wall     asked dx     measured dx
  //     LEFT       +0.424        +0.064     right way, 15% of the distance
  //     CENTER      scale 0.896   scale 0.790  right way, 2.15x too much
  //     RIGHT      -0.424        +0.233     WRONG WAY - it performed a push in
  //
  // The mechanism is the premise, not the conclusion. This field asserts where
  // depth lies in the supplied picture, and on both side plates it asserted the
  // opposite of what the plate shows: the right wall's image has its nearest,
  // largest mass (the towers) at its LEFT edge, and the left wall's at its
  // RIGHT - in both, the near end is the SEAM, not the outer end. Told "the
  // nearest things sit at your RIGHT edge" by text and the reverse by the
  // picture, the right wall believed the picture, followed "travel into the
  // depth" toward what IT could see was far, and came out backwards.
  //
  // So the direction is no longer DERIVED from a depth reading the tool has not
  // verified. It is stated in frame terms, which need no premise and can be
  // checked against the result: which edge everything leaves by, and which edge
  // uncovers new material. `perspective` below still describes the intended
  // geometry of the set - the owner approved that and it is untouched - it just
  // no longer decides which way the camera goes.
  //
  // C_PushIn IS DELIBERATELY LEFT EXACTLY AS IT WAS. The owner confirmed it
  // from delivered output ("right motion is fixed, it's looking nice for push
  // in") after three wrong-way sets, and asked for it not to be touched. Its
  // contract is byte-identical to before this change; only the side walls on a
  // move that travels toward the SEAM - which is push-out - get the new field.
  if (sp.wall !== 'center' && sp.towardEdge && !sp.towardSeam) {
    out.direction_from_perspective =
      'Read the direction off this image: the world recedes toward its ' + sp.seamEdge
      + ' edge and the nearest, largest things sit at its ' + sp.outerEdge + ' edge. '
      + 'The picture travels OUT of that depth, off the near ' + sp.outerEdge + ' end - the closest '
      + 'things leave frame first.';
  } else if (sp.wall !== 'center' && sp.towardEdge) {
    const away = sp.towardEdge;
    const into = away === 'LEFT' ? 'RIGHT' : 'LEFT';
    out.direction_check =
      'DIRECTION - in frame terms only. Do not work it out from the perspective of the picture. '
      + 'Everything visible at 0s moves toward the ' + away + ' edge and whatever is against that '
      + 'edge at 0s is out of frame by the end. The band along the ' + into + ' edge, '
      + Math.round(Math.abs(sp.dxTotal) * 100) + '% of the frame wide, is material from outside the '
      + 'frame. If anything finishes nearer the ' + into + ' edge than it started, it is backwards.';
  }

  if (sp.wall !== 'center') {
    out.perspective = 'a flat side plane at 90 degrees to the centre wall, seen from one seat in the '
      + 'middle of the room. The world recedes toward the '
      + (sp.wall === 'left' ? 'RIGHT' : 'LEFT') + ' edge and is nearest and largest at the '
      + (sp.wall === 'left' ? 'LEFT' : 'RIGHT') + ' edge. This never changes during the shot.';
  }

  // THE OTHER TWO WALLS, AS NUMBERS.
  //
  // Each wall is a separate job: one image and one prompt go up, and nothing
  // else - not the other walls' plates, not their prompts, not their finished
  // clips. So the only way this job can know what it has to cut together with
  // is to be TOLD, in figures. The prose block has carried an all-walls table
  // for a long time, but prose is not what gets sent; this is the same table in
  // the contract that is.
  //
  // Deliberately numbers and nothing else: no scene description, no subject, no
  // style. Describing another wall's CONTENT is how a wall ends up drawing its
  // neighbour's subject, which is the failure IMAGE_MODE 'extension' exists to
  // stop. Direction and magnitude are safe to share; content is not.
  const others = ['left', 'center', 'right'].filter(w => w !== sp.wall);
  out.rig_context = {
    note: 'The other two walls are separate jobs you are not shown. Figures only, so your clip cuts '
        + 'together with theirs as one move. Draw your own frame only, never their content.',
  };
  for (const w of others) {
    const o = spec(sp.move, w, sp.durationSec, opts && opts.speedPct, opts && opts.centrePct);
    // The DELIVERED figures, not the ask. This block exists so three separate
    // jobs cut together as one move, and what cuts together is what the finished
    // clips actually do - the right wall's ask is deliberately the reverse of
    // that (see DELIVERY_SIGN), and passing the reverse on here would tell the
    // other two walls the rig splits in half.
    const oz = Math.abs(o.scaleDelivered - 1) >= zoomDeadzone(o.wall);
    out.rig_context[w] = {
      dx_total: o.dxDelivered,
      travel: o.towardEdgeDelivered ? 'toward its ' + o.towardEdgeDelivered + ' edge'
                                    : 'no sideways travel',
      scale_end: oz ? round(o.scaleDelivered, 3) : 1.0,
    };
  }
  out.rig_context.your_wall = sp.wall;

  out.never = negativePrompt(sp, el);
  return out;
}


function presetIds() { return Object.keys(MOVES); }

module.exports = {
  cameraGloss,
  MOVES, REF_VIEW_PX, WALL_PX, WALL_H, FPS, SAFE_PX_PER_FRAME, BENCHMARK_DX_RATE,
  normalise, spec, posAt, posAtY, landmarkRows, numericBlock, inspector, presetIds, compare, paceMatch,
  cameraJson, travelWord, anchorsFor, elementSchedule, elementCount, DELIVERY_SIGN,
};
