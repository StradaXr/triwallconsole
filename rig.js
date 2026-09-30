const RIGMOVES = require('./rigmoves.js');
// rig.js — the tri-wall camera RIG model.
//
// WHY THIS FILE EXISTS
// --------------------
// The original locked video rules treated each wall as an independent camera
// with its own hand-written rule: centre "dolly forward", left "truck right",
// right "truck left". Three rules, written separately, that happened to be
// pointed in sensible directions. That is why generated sets came out with the
// right topology but wrong magnitudes — nothing tied the three speeds
// together, so each job sampled its own pace.
//
// This file replaces that with ONE rig intent that DERIVES all three walls'
// rules. You state what the physical camera does; the three locked blocks fall
// out of it, already coupled, already mirror-symmetric, with the numbers
// stated explicitly in the text so the generator has something checkable.
//
// MEASURED GROUND TRUTH (see motion_probe.py, and RIG_TARGETS below)
// ------------------------------------------------------------------
// From a real UE5/nDisplay tri-wall render of a forward push-in:
//     LEFT   mean dx  -0.291   radial +0.241
//     CENTRE mean dx  -0.052   radial +0.513   parallax(near-far) -0.357
//     RIGHT  mean dx  +0.307   radial +0.125
// Read that as: a push-in is ONE RADIAL DIVERGENCE FIELD centred on the centre
// wall. Centre has ~zero net lateral flow but the strongest divergence (a true
// dolly — near and far separate). The side walls carry the motion laterally
// OUTWARD, equal and opposite, |L|/|R| = 1.06.
//
// NOBODY PUSHES IN EXCEPT CENTRE. Three walls all dollying forward is the
// failure mode this whole file exists to prevent — it does not stitch, because
// in the real room the side walls are looking sideways at a world that is
// sliding past, not toward, the viewer.
//
// From the same measurement on a Higgsfield-generated set: signs correct in all
// three seasons, but |R/L| ranged 0.72-1.85 and the side-to-centre coupling was
// ~8x too high. Those are the two numbers CALIBRATION targets.

// ---------------------------------------------------------------- targets ---
const RIG_TARGETS = {
  // |dx_left| / |dx_right| — how mirror-symmetric the two side walls are.
  // 1.0 is perfect. Measured 1.06 on the UE5 plate (1.185 with background-band
  // sampling), 0.72-1.85 on the Higgsfield sets.
  lrSymmetry: 1.06,
  lrSymmetryTolerance: 0.25,

  // |mean side dx| / centre radial divergence. UE5: 0.29/0.51 = 0.58.
  // Higgsfield fall row: 1.05/0.13 = 8.1 — sides running away from the centre.
  sideToCentreCoupling: 0.58,
  sideToCentreTolerance: 0.30,

  // Centre parallax (near-third dx minus far-third dx). Must be clearly
  // non-zero or the "dolly" is really a zoom. UE5 centre: -0.357.
  minCentreParallax: 0.08,

  // Element choreography, measured off the fall butterfly:
  // 91.3% of rig width in 5.0s = 18.27%/s, 1.82s dwell per wall.
  elementRatePctPerSec: 17.5,
  elementPerWallSec: 1.9,
  elementFullTraverseSec: 5.7,
};

// Physical rig description. The side walls are NOT at 90 degrees in the real
// room — Video03's Unreal wall meshes are angled quads splaying toward the
// viewer. 90 is the working default because it is what the existing locked
// rules assumed and what the approved output was judged against; change it
// here once the real chamfer angle is confirmed (it is still an open question
// in the wall ledger) and every prompt updates with it.
const RIG_GEOMETRY = {
  sideWallAngleDeg: 90,
  note: 'Side wall angle off centre\'s forward axis. Confirm against the real ' +
        'LR/RR return geometry before trusting the absolute number.',

  // KEYSTONE — the fix for "the perspective is wrong".
  //
  // The side walls are angled planes, and from the eyepoint their OUTER edge is
  // nearer than their inner (seam) edge, so it subtends a larger angle. Measured
  // off the Unreal wall meshes in the nDisplay recording: a side quad's outer
  // edge renders 1.40-1.58x the apparent height of its inner edge, depending on
  // where the editor camera happened to be.
  //
  // That spread is exactly why this is a SETTING and not a hard constant: the
  // recording's camera free-flies, so it cannot give the true audience-eyepoint
  // figure. The authoritative number comes from the room — inner-edge distance
  // divided by outer-edge distance from the eyepoint — and should be measured
  // once and set here.
  //
  // A flat, un-keystoned image on an angled wall reads as a photograph hung on
  // that wall rather than a window onto the world. Pre-warping it is what makes
  // the three panels resolve into one space, and is what was done by hand in
  // Photoshop to correct a generated set.
  sideKeystone: 1.45,
  keystoneNote: 'Apparent height of a side wall\'s OUTER edge divided by its INNER '
              + '(seam) edge, from the eyepoint. 1.0 = no warp. Measured 1.40-1.58 off '
              + 'the Unreal wall meshes; confirm against the real room and set it once.',
};

// ------------------------------------------------------ grade / eyeline lock ---
// Added after a delivered set failed to stitch on three separate axes at once —
// motion was only one of them. Measured on the stitched plate:
//   LEFT warmth -52 vs centre, contrast -27
//   RIGHT luma -31, warmth -35, saturation -21, contrast -32, horizon -0.124
// Every one of those is invisible to a motion-only check and fatal on the wall.
//
// `ref` is the centre wall's measured grade (see motion_probe.py grade_of).
// With no measurement yet, the wording still holds the walls together — it just
// cannot quote numbers.
function buildGradeLock(ref) {
  const base =
    'Fixed grade rule: all three walls are ONE photograph of ONE moment, so lighting must be '
  + 'identical across them — same time of day, same sun or key direction and height, same colour '
  + 'temperature, same exposure, same contrast and black level, same weather and haze. A side wall '
  + 'that is cooler, darker, flatter or less saturated than the centre reads instantly as a '
  + 'different shot when the three are played side by side, and that is the single most common way '
  + 'a set fails on the wall.';
  if (!ref || typeof ref.luma !== 'number') return base;
  const temp = ref.warmth > 8 ? 'warm' : ref.warmth < -8 ? 'cool' : 'neutral';
  return base + ` Match the centre wall specifically: a distinctly ${temp} cast `
    + `(red channel ${ref.warmth >= 0 ? 'above' : 'below'} blue by about ${Math.abs(Math.round(ref.warmth))} `
    + `points on a 0-255 scale), mid-brightness around ${Math.round(ref.luma)}/255, `
    + `${ref.contrast > 65 ? 'punchy, high' : ref.contrast > 45 ? 'moderate' : 'soft, low'} contrast, `
    + `and ${ref.sat > 80 ? 'rich' : ref.sat > 55 ? 'moderate' : 'muted'} saturation. Do not render `
    + `this wall cooler, darker or flatter than that.`;
}

const HORIZON_LOCK =
  'Fixed eyeline rule: the horizon sits at the SAME height in every wall, because all three are '
  + 'shot from one camera at one height. Keep the horizon line, the ground plane and the eye level '
  + 'continuous across the seams — if the horizon steps up or down where two walls meet, the '
  + 'illusion of one space collapses, however well everything else matches. Do not tilt the camera '
  + 'up or down relative to the other walls, and do not raise or lower the viewpoint.';

// ------------------------------------------------- measured correction rule ---
// The decoder's numbers, written INTO the prompt for the wall they describe.
//
// Measuring a set and then not telling the generator what the measurement said
// is the gap that let the same three faults repeat across versions. This turns
// a reading into an instruction: here is what the centre is, here is what THIS
// wall came back as last time, here is the direction to correct in.
//
// `measured` is { grades: {LEFT,CENTER,RIGHT}, horizons: {...}, motion: {...} }
// as captured at decode time. Returns null when nothing has been measured.
function buildMeasuredMatchRule(wallId, measured) {
  if (!measured || !measured.grades || !measured.grades.CENTER) return null;
  const KEY = wallId.toUpperCase();
  const C = measured.grades.CENTER;
  const Ch = measured.horizons && measured.horizons.CENTER;

  const target =
    `Fixed measured-match rule — these are real measurements taken off the decoded reference plate, `
  + `not estimates. The CENTRE wall measures: mid-brightness ${Math.round(C.luma)}/255, `
  + `${C.warmth >= 0 ? 'warm' : 'cool'} cast with red ${C.warmth >= 0 ? 'above' : 'below'} blue by `
  + `${Math.abs(Math.round(C.warmth))} points, contrast ${Math.round(C.contrast)}, saturation `
  + `${Math.round(C.sat)}/255${Ch != null ? `, horizon at ${Math.round(Ch * 100)}% of frame height` : ''}. `
  + `This wall must land on those same figures.`;

  if (wallId === 'center') return target;

  const M = measured.grades[KEY];
  const Mh = measured.horizons && measured.horizons[KEY];
  if (!M) return target;

  // Only name the axes that are actually out, and give a direction for each.
  const fixes = [];
  const dl = M.luma - C.luma, dw = M.warmth - C.warmth,
        ds = M.sat - C.sat, dc = M.contrast - C.contrast;
  if (Math.abs(dl) > 12) fixes.push(`${dl < 0 ? 'BRIGHTER' : 'DARKER'} by about ${Math.abs(Math.round(dl))} points of brightness`);
  if (Math.abs(dw) > 15) fixes.push(`much ${dw < 0 ? 'WARMER' : 'COOLER'} — it was ${Math.abs(Math.round(dw))} points off the centre's colour temperature`);
  if (Math.abs(ds) > 12) fixes.push(`${ds < 0 ? 'MORE' : 'LESS'} saturated by about ${Math.abs(Math.round(ds))}`);
  if (Math.abs(dc) > 18) fixes.push(`${dc < 0 ? 'PUNCHIER, with deeper blacks and brighter highlights' : 'FLATTER'} — contrast was ${Math.abs(Math.round(dc))} off`);
  if (Ch != null && Mh != null && Math.abs(Mh - Ch) > 0.04) {
    fixes.push(`its horizon ${Mh < Ch ? 'LOWERED' : 'RAISED'} by about ${Math.abs(Math.round((Mh - Ch) * 100))}% of frame height so the eyeline lines up with the centre across the seam`);
  }
  if (!fixes.length) {
    return target + ` The previous version of this wall already matched on lighting and eyeline — hold it there.`;
  }
  return target
    + ` The previous version of THIS wall did not match, and the specific corrections are: it needs to be `
    + fixes.join('; ') + `. Apply every one of those; they are the difference between three panels that `
    + `read as one photograph and three that read as three.`;
}

// The perspective rule for a SIDE wall, in language a generator can act on.
// Text alone cannot produce a true homography — that is what the keystone warp
// is for — but it does stop the model composing a flat, face-on photograph that
// has no convergence in it at all to warp.
function perspectiveRule(wallId) {
  if (wallId === 'center') {
    return 'Fixed perspective rule: this wall is viewed face-on and square. Vertical lines stay '
         + 'vertical and parallel, the horizon runs straight and level across the frame, and there '
         + 'is no keystone or convergence.';
  }
  const side = wallId === 'left' ? 'left' : 'right';
  const outer = side.toUpperCase();
  const inner = side === 'left' ? 'RIGHT' : 'LEFT';
  return `Fixed perspective rule: this wall is an angled plane seen from the side, NOT a flat photo `
       + `taken face-on. The world must recede INTO the frame toward the ${inner} edge, where this wall `
       + `meets the centre: things nearest the camera sit at the ${outer} edge and are largest, and `
       + `everything gets smaller, lower-contrast and more distant as it approaches the ${inner} edge. `
       + `Whatever lines run along the wall's direction in this particular scene — the edges of the ground `
       + `plane, ridges, borders, rails, markings, the tops and bases of whatever structures are present — `
       + `must CONVERGE toward a vanishing point beyond the ${inner} edge, not `
       + `run flat and parallel across the frame. The horizon or eyeline still stays level and at the same height `
       + `as the other walls; it is the converging lines, not the horizon, that carry the angle. A `
       + `straight-on, evenly-scaled view with no convergence is wrong here, even though it is correct `
       + `for the centre wall.`;
}

// The selectable rig controllers ARE the C_* moves now: one per reference
// recording, so "C_PushIn" in the tool and C_PushIn.mp4 on disk are the same
// thing by construction. Legacy ids (push_in, yaw_left, ...) still resolve
// through RIGMOVES.normalise, so saved state and the heuristic classifier keep
// working.
const INTENTS = Object.fromEntries(
  RIGMOVES.presetIds().map(id => [id, { label: RIGMOVES.MOVES[id].label,
                                  family: RIGMOVES.MOVES[id].family,
                                  summary: RIGMOVES.MOVES[id].summary,
                                  measured: RIGMOVES.MOVES[id].measured }]));

// ------------------------------------------------------------- shared text ---
const RIG_NOTE =
  'This is one of three synchronized displays in a three-monitor video wall. All three ' +
  'render at 4K (3840x2160) and 30fps and must match exactly in lighting, time of day, ' +
  'season, weather and colour grade — they are three views from ONE camera position at ' +
  'ONE moment, not three separate shots.';

// The single most important sentence in the whole app. Everything else is
// elaboration of this.
const ONE_RIG_LAW =
  'CRITICAL — all three walls share ONE physical camera position. They are three windows ' +
  'out of one viewpoint, facing different directions. Whatever the camera does, it does ' +
  'ONCE, and each wall shows what that single movement looks like from its own facing ' +
  'direction. The three walls do NOT each perform the movement separately.';

const PARALLAX_TEST =
  'Parallax is the test for whether this is real camera movement: nearer elements must ' +
  'shift across the frame noticeably faster than distant ones, which barely move at all. ' +
  'If the whole frame scales or slides uniformly, with no difference between near and far, ' +
  'that is a lens zoom or a pan and it is WRONG.';

function speedClause(pct) {
  return `one constant, unchanging speed for the entire clip (speed dial ${pct ?? 100}% of the reference pace)`;
}

// ------------------------------------------------------- per-wall movement ---
// Each branch answers: given this ONE rig movement, what does THIS wall see?
function movementRule(wallId, rig) {
  const { intent, speedPct, yawDegPerSec, tiltDegPerSec, durationSec } = rig;
  const side = wallId === 'left' ? 'left' : wallId === 'right' ? 'right' : null;
  const outer = side;                                   // each side wall's outer edge
  const inner = side === 'left' ? 'right' : 'left';     // the edge touching centre

  if (intent === 'hold') {
    return IDLE_RULE;
  }

  if (intent === 'push_in' || intent === 'pull_out') {
    const fwd = intent === 'push_in';
    if (wallId === 'center') {
      return `Fixed movement rule: the camera physically travels ${fwd ? 'FORWARD into' : 'BACKWARD out of'} ` +
        `the scene in a dead-straight line, at ${speedClause(speedPct)}. This wall looks straight ` +
        `down the direction of travel, so its content expands outward from the centre of the frame ` +
        `${fwd ? 'toward' : 'away from'} the edges${fwd ? ' as things pass the camera' : ''} — ` +
        `this is the only wall on which anything approaches or recedes. ${PARALLAX_TEST} Do not ` +
        `rotate, pan, tilt or roll the camera at any point; its facing direction never changes, and ` +
        `it never speeds up, slows down, stops or reverses.`;
    }
    // THE KEY RULE. A forward move makes side-wall content sweep toward the
    // OUTER edge — the world slides past you, it does not come at you.
    const dir = fwd ? outer : inner;
    return `Fixed movement rule: the camera physically travels ${fwd ? 'FORWARD' : 'BACKWARD'} at ` +
      `${speedClause(speedPct)} — but THIS wall faces ${RIG_GEOMETRY.sideWallAngleDeg} degrees to the ` +
      `${side} of that direction of travel, so it does NOT look down the line of travel and nothing ` +
      `in it approaches the camera. Instead the whole landscape slides steadily PAST the camera and ` +
      `off the ${dir.toUpperCase()} edge of this frame, the way scenery slides past a side window of a ` +
      `moving vehicle. The camera itself never turns, never zooms, and never moves toward or away from ` +
      `what it is looking at — its distance from the scene stays constant while the scene travels past ` +
      `it. ${PARALLAX_TEST} By the end of the clip the framing must have visibly slid: content that ` +
      `started near the ${inner.toUpperCase()} edge should have travelled a clear distance toward the ` +
      `${dir.toUpperCase()} edge. Slow, smooth and perfectly even — never jarring, never stopping, ` +
      `never reversing.`;
  }

  if (intent === 'truck_left' || intent === 'truck_right') {
    const goingLeft = intent === 'truck_left';
    if (wallId === 'center') {
      return `Fixed movement rule: the camera physically slides sideways to the ${goingLeft ? 'LEFT' : 'RIGHT'} ` +
        `at ${speedClause(speedPct)}, staying at a constant distance from the scene and never changing ` +
        `its facing direction. Content therefore travels across this frame toward the ` +
        `${goingLeft ? 'RIGHT' : 'LEFT'} edge. ${PARALLAX_TEST} No rotation, no pan, no tilt, no zoom, ` +
        `and no movement toward or away from the scene.`;
    }
    // Sliding left means you APPROACH the left wall's subject and RECEDE from
    // the right wall's. This is the asymmetric case — the two sides are NOT
    // mirror images here, unlike a push-in.
    const approaching = (goingLeft && side === 'left') || (!goingLeft && side === 'right');
    return `Fixed movement rule: the camera physically slides sideways to the ${goingLeft ? 'LEFT' : 'RIGHT'} ` +
      `at ${speedClause(speedPct)} without ever turning. THIS wall faces ` +
      `${RIG_GEOMETRY.sideWallAngleDeg} degrees to the ${side} of centre's forward direction, which means ` +
      `that sideways travel is, for this wall, movement ${approaching ? 'STRAIGHT TOWARD' : 'STRAIGHT AWAY FROM'} ` +
      `what it is looking at. So this wall's content ${approaching
        ? 'expands outward from the centre of the frame as the camera closes in on it'
        : 'contracts inward toward the centre of the frame as the camera retreats from it'}. ` +
      `${PARALLAX_TEST} The camera never rotates, never pans, and never zooms — the change in scale ` +
      `comes entirely from real distance closing${approaching ? '' : ' or opening'}.`;
  }

  if (intent === 'yaw_left' || intent === 'yaw_right') {
    const turningLeft = intent === 'yaw_left';
    const contentDir = turningLeft ? 'RIGHT' : 'LEFT';
    const total = Math.round(Math.abs(yawDegPerSec) * (durationSec || 5));
    // A rotation is COMMON MODE: every wall shifts the same way by the same
    // angle, because the whole rig turned as one rigid body.
    return `Fixed movement rule: the entire camera rig ROTATES ${turningLeft ? 'LEFT' : 'RIGHT'} in place ` +
      `about its own vertical axis, at a steady ${Math.abs(yawDegPerSec).toFixed(1)} degrees per second — ` +
      `about ${total} degrees over the whole clip. The camera does NOT change position: it pivots where ` +
      `it stands. ${wallId === 'center' ? 'This wall' : `This wall faces ${RIG_GEOMETRY.sideWallAngleDeg} ` +
      `degrees to the ${side} of centre, and because the whole rig is one rigid body it turns through ` +
      `exactly the same ${Math.abs(yawDegPerSec).toFixed(1)} degrees per second as every other wall. It`} ` +
      `therefore sweeps its content steadily toward the ${contentDir} edge of frame at that same angular ` +
      `rate. Because this is a rotation and not a move, near and far elements travel across the frame at ` +
      `close to the SAME rate — there is little or no parallax, and that is correct here. Do not dolly, ` +
      `truck, zoom or tilt; the only change is heading.`;
  }

  if (intent === 'tilt_up' || intent === 'tilt_down') {
    const up = intent === 'tilt_up';
    const total = Math.round(Math.abs(tiltDegPerSec) * (durationSec || 5));
    return `Fixed movement rule: the entire camera rig TILTS ${up ? 'UPWARD' : 'DOWNWARD'} in place about ` +
      `its horizontal axis, at a steady ${Math.abs(tiltDegPerSec).toFixed(1)} degrees per second — about ` +
      `${total} degrees over the clip. The camera does not change position. Every wall in the rig tilts ` +
      `through the same angle at the same moment, so this wall's content slides steadily ` +
      `${up ? 'DOWNWARD' : 'UPWARD'} through frame, revealing ${up ? 'more sky above' : 'more ground below'}. ` +
      `Horizontal position is unchanged — no sideways drift at all. As with any rotation, near and far ` +
      `move at nearly the same rate; there is little parallax and that is correct. Do not dolly, truck or zoom.`;
  }

  return IDLE_RULE;
}

const IDLE_RULE =
  'Fixed movement rule: the camera is completely static for the entire clip — no dolly, truck, pan, ' +
  'tilt, roll or zoom. Its position and facing direction are identical in the first and last frame. ' +
  'All visible motion comes from within the scene itself (drifting cloud, falling snow, rippling water, ' +
  'flickering light, stirring foliage), never from the camera.\n\n' +
  'Fixed loop rule: this clip plays on a continuous loop, so it must loop seamlessly — the last frame ' +
  'has to lead back into the first with no visible jump, cut or flash. Keep ambient motion cyclical or ' +
  'steady-state rather than cumulative: falling snow and flickering light loop, a cloud drifting off one ' +
  'edge and never returning does not.';

// ---------------------------------------------------------------- framing ---
function angleRule(wallId) {
  if (wallId === 'center') {
    return 'Fixed camera-angle rule: this is the CENTRE wall. Its forward-facing direction is the ' +
      '0-degree reference axis, and it is the one wall that looks along the rig\'s direction of travel.';
  }
  const side = wallId === 'left' ? 'left' : 'right';
  return `Fixed camera-angle rule: this is the ${side.toUpperCase()} wall. Its camera is oriented at exactly ` +
    `${RIG_GEOMETRY.sideWallAngleDeg} degrees to the ${side} of the centre wall's forward direction and stays ` +
    `locked at that offset for the whole clip. If the attached reference image's apparent angle looks ` +
    `different, treat that image purely as a content and style reference — the facing direction stays locked ` +
    `at ${RIG_GEOMETRY.sideWallAngleDeg} degrees ${side} of centre regardless of what the photo shows.`;
}

// ----------------------------------------------------------- choreography ---
// The fall butterfly: prompted as one element, timed so it crosses all three
// walls and reads as continuous when stitched. Measured at 18.27%/s, 1.82s per
// wall, right-to-left, entering ~2s in. This turns that into instructions.
// THE TIMETABLE IS NOT COMPUTED HERE ANY MORE. This function, the page and
// principles.js each had their own version of it and they disagreed: the page
// wrote 33.3/rate into perWallSec, this file fell back to a flat 1.9s, and
// neither checked the crossing fitted inside the clip. Whichever copy a reader
// reached for decided the timing. rigspec.elementSchedule is the only copy.
function choreographyRule(wallId, rig) {
  const c = rig.element;
  const sched = require('./rigspec.js').elementSchedule(rig, wallId);
  if (!sched) return null;
  const dir = sched.direction;
  const perWall = sched.perWallSec;
  const order = sched.order;
  const idx = sched.index;
  const inAt = sched.inAt;
  const outAt = sched.outAt;
  const enterEdge = sched.enterEdge;
  const exitEdge = sched.exitEdge;
  const prevWall = idx > 0 ? order[idx - 1] : null;
  const nextWall = idx < 2 ? order[idx + 1] : null;

  // "a single 5 large Owl" told the reader the count was both five and one.
  const many = sched.count && sched.count > 1;
  return `Fixed travelling-element rule: ${many ? '' : 'a single '}${c.subject} ` +
    `cross${many ? '' : 'es'} the whole three-wall rig as one ` +
    `continuous journey, ${dir.replace(/_/g, '-')}, at a steady pace of about ` +
    `${sched.roomPctPerSec.toFixed(1)}% of the total wall width per second. ` +
    `On THIS wall it must enter frame at the ${enterEdge} edge at about ${inAt}s and exit at the ` +
    `${exitEdge} edge at about ${outAt}s — roughly ${perWall}s on screen, crossing at a constant speed and ` +
    `constant height, never pausing, never reversing, never leaving and re-entering. ` +
    (prevWall ? `It is arriving from the ${prevWall.toUpperCase()} wall, so it must already be mid-flight and ` +
      `partially cut off by the ${enterEdge} frame edge at the moment it appears — not starting from a stop. ` : '') +
    (nextWall ? `It continues onto the ${nextWall.toUpperCase()} wall, so it must still be mid-flight and ` +
      `partially cut off by the ${exitEdge} frame edge as it leaves — not stopping or fading out. ` : '') +
    `Keep its size, colour, lighting and flight rhythm identical to how it reads on the other walls; it is ` +
    `ONE ${c.subject} seen from one continuous camera, not a separate one per wall. ` +
    `Outside ${inAt}s-${outAt}s it is not in this frame at all.`;
}

// ------------------------------------------------------------- assembling ---
const PRINCIPLES = require('./principles.js');

// v3.2: the locked block is now the Sizzle Wall Runbook's theatre principles
// plus a camera track derived from the rig — no invented speed, no asserted
// wall angle. See principles.js for what was removed and why. The old builder
// is kept below as buildFixedVideoRulesLegacy for reference; nothing calls it.
function buildFixedVideoRules(wallId, rig) {
  // The numeric grade lock was only ever reaching the IMAGE block. Video
  // generations need it just as much — a side clip that comes back 22 points
  // cooler than the centre is exactly as unusable as a still that does.
  const gradeRule = buildGradeLock(rig && rig.gradeRef);
  const measured = buildMeasuredMatchRule(wallId, rig && rig.measured);
  // The travelling-element choreography. choreographyRule() has existed since
  // the butterfly was measured, but only the LEGACY builder ever called it — so
  // naming an element did nothing at all to the prompts the tool actually sent.
  // Dead since the locked block was rewritten.
  const chor = choreographyRule(wallId, rig || {});
  const NL2 = String.fromCharCode(10);
  const extra = [gradeRule, measured, chor].filter(Boolean).join(NL2 + NL2);
  return PRINCIPLES.buildLockedBlock(wallId, rig, extra);
}

function buildFixedVideoRulesLegacy(wallId, rig) {
  const parts = [ONE_RIG_LAW, angleRule(wallId), movementRule(wallId, rig)];
  const chor = choreographyRule(wallId, rig);
  if (chor) parts.push(chor);
  // Grade and eyeline are as load-bearing as the movement rule: a delivered set
  // failed to stitch on colour and horizon while its motion was merely wrong,
  // not absent. Both go in every wall's locked block.
  parts.push(perspectiveRule(wallId));
  parts.push(buildGradeLock(rig && rig.gradeRef));
  parts.push(HORIZON_LOCK);
  // The decoder's own numbers, addressed to this wall. Null until something
  // has been decoded, so nothing is invented before there is evidence.
  const measured = buildMeasuredMatchRule(wallId, rig && rig.measured);
  if (measured) parts.push(measured);
  parts.push(RIG_NOTE);
  return parts.join('\n\n');
}

// What the PROMPT BOT is told about this wall's locked block.
//
// Per the handoff's prompt rules: the bot must never SEE the locked block (it
// would restate or contradict it), but it must be TOLD, in the instruction's
// own words, what that block already covers — otherwise it writes text that
// fights it. The old instruction hardcoded "pushing straight forward" for
// centre and "drifting toward the far side" for the sides, which was only ever
// right for one rig intent. Decode a yaw, draft a prompt, and the bot was being
// briefed on a push-in that was not happening.
function promptBotRigContext(wallId, rig) {
  const intent = (rig && rig.intent) || 'push_in';
  const side = wallId === 'left' ? 'left' : wallId === 'right' ? 'right' : null;
  const outer = side;
  const inner = side === 'left' ? 'right' : 'left';
  const W = wallId.toUpperCase();

  // If a plate has been decoded, tell the writer the measured look so its
  // variable text does not describe a mood that fights the locked grade.
  let measuredNote = '';
  const mg = rig && rig.measured && rig.measured.grades && rig.measured.grades.CENTER;
  if (mg) {
    measuredNote = ` Measured from the reference plate, the scene is `
      + `${mg.luma < 70 ? 'fairly dark' : mg.luma > 120 ? 'bright' : 'mid-brightness'}, `
      + `${mg.warmth > 8 ? 'warm-toned' : mg.warmth < -8 ? 'cool-toned' : 'neutral'} and `
      + `${mg.contrast > 65 ? 'high-contrast' : 'moderate contrast'} — keep anything you describe `
      + `consistent with that, and do not introduce light sources or weather that would change it.`;
  }

  const lead = `This is the ${W} wall of the rig.${measuredNote}`;
  // The old tail forbade mentioning the camera at all, so the drafted text read
  // as if the shot were locked off no matter what the rig was doing — the user's
  // "the descriptive prompt still does not mention anything about camera path".
  // The rule it was protecting is real (the locked block owns the camera, and
  // restating it causes contradictions), but it was drawn too wide. The motion
  // inside the scene has to be described RELATIVE to the camera's travel, so one
  // clause tying the two together is now required, not banned.
  const tail = ' A separate fixed block already states the camera rule in full — do not restate it and do '
             + 'not give it numbers. But DO write the ambient motion as it is seen from this moving camera: '
             + 'say what passes, what is overtaken, what holds still against the travel, so the description '
             + 'reads as being shot from this move rather than from a locked-off tripod.';

  switch (intent) {
    case 'push_in':
    case 'pull_out': {
      const fwd = intent === 'push_in';
      if (wallId === 'center') {
        return `${lead} The camera is travelling ${fwd ? 'forward into' : 'backward out of'} the scene, so `
             + `this view's content expands outward from the centre of frame${fwd ? ' as things pass the camera' : ''}.`
             + tail;
      }
      return `${lead} The camera is travelling ${fwd ? 'forward' : 'backward'}, but this wall looks sideways `
           + `to the ${side}, so nothing approaches it — the landscape slides steadily past and off the `
           + `${(fwd ? outer : inner).toUpperCase()} edge of frame, like scenery past a side window.` + tail;
    }
    case 'truck_left':
    case 'truck_right': {
      const goingLeft = intent === 'truck_left';
      if (wallId === 'center') {
        return `${lead} The camera is sliding sideways to the ${goingLeft ? 'left' : 'right'}, so content `
             + `travels across this frame toward the ${goingLeft ? 'right' : 'left'} edge.` + tail;
      }
      const approaching = (goingLeft && side === 'left') || (!goingLeft && side === 'right');
      return `${lead} The camera is sliding sideways to the ${goingLeft ? 'left' : 'right'}, which for this `
           + `wall is movement ${approaching ? 'straight toward' : 'straight away from'} what it looks at, so its `
           + `content ${approaching ? 'expands' : 'contracts'}.` + tail;
    }
    case 'yaw_left':
    case 'yaw_right': {
      const turningLeft = intent === 'yaw_left';
      return `${lead} The whole rig is ROTATING ${turningLeft ? 'left' : 'right'} in place at about `
           + `${Math.abs(rig.yawDegPerSec || 0).toFixed(1)} degrees per second — it is not travelling anywhere. `
           + `Every wall turns through the same angle, so this view sweeps steadily toward its `
           + `${turningLeft ? 'RIGHT' : 'LEFT'} edge with little parallax.` + tail;
    }
    case 'tilt_up':
    case 'tilt_down': {
      const up = intent === 'tilt_up';
      return `${lead} The whole rig is TILTING ${up ? 'up' : 'down'} in place at about `
           + `${Math.abs(rig.tiltDegPerSec || 0).toFixed(1)} degrees per second. Content slides `
           + `${up ? 'downward' : 'upward'} through frame; horizontal position does not change.` + tail;
    }
    default:
      return `${lead} The camera is completely LOCKED OFF — it does not move at all, and the clip must loop `
           + `seamlessly. Everything visibly moving therefore has to come from within the scene itself, and `
           + `it must be cyclical or steady-state so the loop point is invisible (falling snow and flickering `
           + `light loop; a cloud drifting off one edge and never returning does not).` + tail;
  }
}

function describeRig(rig) {
  // Through normalise(), so a legacy id saved by an older version still
  // resolves. The previous fallback was INTENTS.hold, which stopped
  // existing when the moves became C_* and threw on every rig read.
  const i = INTENTS[RIGMOVES.normalise(rig && rig.intent)];
  const bits = [i.label];
  if (i.family === 'translate' && rig.intent !== 'hold') bits.push(`speed ${rig.speedPct ?? 100}%`);
  if (rig.intent === 'yaw_left' || rig.intent === 'yaw_right') bits.push(`${rig.yawDegPerSec}°/s`);
  if (rig.intent === 'tilt_up' || rig.intent === 'tilt_down') bits.push(`${rig.tiltDegPerSec}°/s`);
  if (rig.element && rig.element.enabled && rig.element.subject) {
    bits.push(`element: ${rig.element.subject} ${(rig.element.direction || 'right_to_left').replace(/_/g, '-')}`);
  }
  return bits.join(' · ');
}

// --------------------------------------------------- decode -> rig intent ---
// Turns motion_probe.py output into a rig spec the page can use directly.
function rigFromProbe(probe, base) {
  const rig = Object.assign({}, base);
  const m = (probe && probe.motion) || {};
  if (m.intent) rig.intent = m.intent;
  if (typeof m.yaw_deg_per_s === 'number') rig.yawDegPerSec = +Math.abs(m.yaw_deg_per_s).toFixed(2);
  if (typeof m.pitch_deg_per_s === 'number') rig.tiltDegPerSec = +Math.abs(m.pitch_deg_per_s).toFixed(2);
  if (probe && probe.duration_s) rig.durationSec = Math.min(10, Math.round(probe.duration_s));

  // Measured rate -> the speed dial, directly. This used to invent a km/h
  // figure through a stated convention (7.8%/s == 15 km/h) because the dial's
  // unit was km/h and pixels carry no depth. The dial is a percentage of a
  // measured rate now, and the probe reports that same kind of rate, so the
  // two meet without any convention in between: 100% is RIGSPEC.BENCHMARK_DX_RATE
  // per second.
  //
  // TWO candidate rates, because motion_probe.py's own decomposition (see its
  // module docstring) splits flow into a differential component (push_rate -
  // CENTER's radial expansion, real for a push/pull) and a common-mode
  // component (lateral_frac - uniform flow, real for a truck/yaw). A single-
  // axis move only ever drives ONE of them: a pure sideways truck has ~zero
  // radial expansion, so gating on push_rate alone silently left Speed%
  // untouched on every decoded truck_left/truck_right/yaw_* clip. Taking
  // whichever magnitude is larger works for both without having to pattern-
  // match the intent string (and matches classify()'s own reasoning for
  // picking an intent in the first place).
  const pushRate = typeof m.push_rate_pct_per_s === 'number' ? m.push_rate_pct_per_s : 0;
  const lateralRate = typeof m.lateral_frac_per_s === 'number' ? m.lateral_frac_per_s * 100 : 0;
  const measuredRate = Math.abs(pushRate) >= Math.abs(lateralRate) ? pushRate : lateralRate;
  if (Math.abs(measuredRate) > 0.5) {
    const benchPctPerSec = require('./rigspec.js').BENCHMARK_DX_RATE * 100;
    rig.speedPct = Math.max(1, Math.min(1000,
      Math.round(Math.abs(measuredRate) / benchPctPerSec * 100)));
    rig.speedInferred = true;
    // Read by buildLockedJson (principles.js) to add a "DECODED FROM THE
    // CLIENT REFERENCE" line to the prompt - it never fired before this,
    // because nothing ever set this field.
    rig.decodedRate = Math.abs(measuredRate).toFixed(2) + '%/s measured off the reference clip';
  }
  if (probe && probe.elements) {
    // A decoded clip measures a PACE; the rig is set by WINDOWS now, so turn the
    // pace into a chained relay across this clip rather than storing a rate the
    // schedule no longer reads. The operator can then move any of the six boxes.
    const e = probe.elements;
    const dir = e.direction === 'left_to_right' ? 'left_to_right' : 'right_to_left';
    const order = dir === 'right_to_left' ? ['right', 'center', 'left'] : ['left', 'center', 'right'];
    const dur = Math.max(1, Number(rig.durationSec) || 5);
    let perWall = Number(e.per_wall_s) > 0 ? Number(e.per_wall_s) : dur / 3;
    if (perWall * 3 > dur) perWall = dur / 3;          // never point past the clip
    const entry = Math.max(0, Math.min(2.0, dur - perWall * 3));
    const windows = {};
    order.forEach((w, i) => {
      windows[w] = { enter: +(entry + i * perWall).toFixed(2),
                     exit: +(entry + (i + 1) * perWall).toFixed(2) };
    });
    rig.element = Object.assign({}, rig.element, {
      enabled: true, direction: dir, windows: windows, detected: true,
    });
  }
  return rig;
}

function defaultRig() {
  return {
    intent: 'C_PushIn',
    speedPct: 100,
    centrePct: 25,     // rigspec.CENTRE_TRIM_DEFAULT - the centre runs a quarter pace
    yawDegPerSec: 6,
    tiltDegPerSec: 4,
    durationSec: 5,
    element: { enabled: false, subject: '', direction: 'right_to_left',
               // How tall it is as a percent of frame height. Nothing stated
               // this, and one delivered set drew small distant owls on the
               // right wall and a single close-up filling half the frame on the
               // left - same prompt, same reference picture.
               sizePctOfHeight: 12,
               // And how high up it crosses. Same gap, same symptom: the right
               // wall's owls crossed near the horizon and the left wall's sat
               // low, so the room read as three flights rather than one.
               heightPctFromTop: 35,
               // WHEN IT IS ON EACH WALL, in seconds. This replaced the
               // "% of the room per second" pace box: the operator sets the two
               // times per wall and rigspec.elementSchedule reads the crossing
               // speed off them. Defaults chain the relay across a 5s clip.
               windows: { right:  { enter: 0.5, exit: 2.0 },
                          center: { enter: 2.0, exit: 3.5 },
                          left:   { enter: 3.5, exit: 5.0 } } },
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { RIG_TARGETS, RIG_GEOMETRY, INTENTS, buildFixedVideoRules,
                     describeRig, rigFromProbe, defaultRig, movementRule, angleRule,
                     choreographyRule, promptBotRigContext, buildGradeLock, perspectiveRule,
                     buildMeasuredMatchRule, PRINCIPLES,
                     HORIZON_LOCK, ONE_RIG_LAW, IDLE_RULE };
}
