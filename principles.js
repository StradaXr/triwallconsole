const RIGPATHS = require('./rigpaths.js');
const RIGMOVES = require('./rigmoves.js');
const RIGSPEC = require('./rigspec.js');
const THEATRE = require('./theatre.js');

// principles.js — the locked block, rebuilt from the Sizzle Wall Runbook.
//
// WHAT CHANGED AND WHY
// --------------------
// The old locked block had grown to ~2,900 characters per wall of prose, and it
// carried two values that were actively harmful:
//
//   "exactly 15 kilometres per hour"  — an invented number. Nothing measured it;
//       it was a placeholder that then got asserted to the generator as fact,
//       and it fought whatever the decoder actually read off a reference.
//   "exactly 15 kilometres per hour" was the only genuinely disruptive one.
//
// CORRECTION, against the wall brief: I ALSO removed "exactly 90 degrees" on the
// reasoning that the Unreal wall meshes looked like angled quads. That was
// wrong. They look angled because they are drawn in perspective from a
// free-flying editor camera. The room is a literal U — L and R ARE at 90
// degrees, and the 320px returns bridge the corners at 45. The angle is back,
// sourced from theatre.js rather than hardcoded here.
//
// Both are gone. What replaces them is the ROOM's principles, which are stable,
// and the RIG's own decoded values, which are measured. A principle that is
// true regardless of the shot belongs here; a number that depends on the shot
// comes from the rig or the decoder and is stated only when it is real.
//
// SOURCE: the Sizzle Wall Runbook's energy law, expressed in terms a generator
// can act on. The Runbook's own numbers (side temporal lag 0.33s, luminance
// ceiling 0.55 of centre's p99, coherent lateral flow cap 6 px/frame, 2 flashes
// per second over 15% of field) are POST-PROCESS parameters — they are applied
// to plates by the pipeline, not understood by an image model. Asking a video
// model for "an EMA time constant of 0.33 seconds" produces nothing. So each
// one is carried here as the behaviour it is meant to produce.

// ---------------------------------------------------------------- the room ---
const ONE_RIG =
  'ONE CAMERA, THREE WINDOWS. All three walls are one camera position at one moment, facing three '
+ 'directions. The camera moves once; each wall shows that single move from its own facing. The walls '
+ 'never each perform it separately.';

// The parallax expectation — the theatre's core correctness test, and the one
// failure that text alone kept producing (a zoom instead of a move).
const PARALLAX =
  'PARALLAX IS THE TEST. Near things must cross frame visibly faster than distant ones. If near and '
+ 'far shift by the same amount, that is a zoom or a pan and it is wrong.';

// Energy law, from the Runbook. The sides are in peripheral vision, which
// resolves detail poorly but is MORE sensitive to flicker than the fovea, so
// detail and brightness out there cost shimmer and buy nothing.
const ENERGY =
  'SIDES CARRY LESS ENERGY. Side walls sit in peripheral vision: calmer, softer, never brighter, '
+ 'busier or faster than the centre, with less fine detail toward their outer edges.';

// Vection: large-field coherent lateral motion reads as self-motion to the
// vestibular system. This is the one that actually makes people queasy in a
// wraparound room, and the one nobody screens for.
const VECTION =
  'NO FAST WIDE MOTION. In a wraparound room, large areas moving together read as the viewer moving '
+ 'and cause motion sickness. Keep movement slow, smooth and even — clearly visible, never hurried.';

// Photosensitivity. House rule is deliberately tighter than broadcast, because
// broadcast assumes a television across a living room, not a wall that
// surrounds an audience nobody has pre-screened.
const SAFETY =
  'NO FLASHING. No strobing or rapid brightness pulsing over large areas — the limit here is tighter '
+ 'than television.';

// Continuity across the seams. Deliberately qualitative here — the measured
// numbers are appended separately by the match rule, only when they exist.
const CONTINUITY =
  'ONE MOMENT, ONE LIGHT. Identical time of day, sun direction, colour temperature, exposure and '
+ 'contrast on every wall, and the horizon at the same height in all three so the eyeline runs '
+ 'unbroken across the seams.';

const THEATRE_PRINCIPLES = [ONE_RIG, PARALLAX, ENERGY, VECTION, SAFETY, CONTINUITY].join('\n\n');

// ------------------------------------------------------------ camera track ---
// The per-wall movement, derived from the rig. No invented speed, no asserted
// wall angle: a side wall is described by what it DOES ("faces away from the
// direction of travel, so the world slides past it"), which is true at any
// chamfer angle, instead of by a degree figure that may be wrong.
function cameraTrack(wallId, rig) {
  // The per-wall camera paragraph is now a NUMERIC SPEC, not prose. It comes
  // from rigspec.js, whose figures are the theatre's own reference renders
  // decomposed into translation, scale and roll.
  //
  // What the prose version could not say, and what each delivered set got
  // wrong as a result:
  //   * HOW FAR. "Slides steadily" has no magnitude, so one set came back five
  //     times too weak and the next, once a per-second rate was bolted on,
  //     came back about three times too strong — because a 1.9-second
  //     reference beat's rate is not a 5-second clip's rate. The spec states a
  //     TOTAL EXCURSION and divides it by the clip length.
  //   * WHICH WAY, unambiguously. "Toward the LEFT edge" is only meaningful if
  //     you know which edge touches the centre wall, so the spec gives the
  //     sign of dx, the edge name, AND the seam relationship.
  //   * THAT IT IS A CAMERA. One delivered right wall had objects sliding over
  //     a stationary background, which satisfies every word of the prose and
  //     none of its intent.
  const moveId = RIGSPEC.normalise(rig && (rig.move || rig.intent));
  const dur = (rig && rig.durationSec) || 5;
  const NL2 = String.fromCharCode(10) + String.fromCharCode(10);

  const block = RIGSPEC.numericBlock(moveId, wallId, dur, rig && rig.speedPct, rig && rig.centrePct);

  // A decoded reference only ever overrides the TEMPO, never the geometry:
  // the geometry is the room's, the tempo is the client's.
  const rate = (rig && rig.speedInferred && rig.decodedRate)
    ? NL2 + 'DECODED FROM THE CLIENT REFERENCE: ' + rig.decodedRate + '. Where this disagrees with the '
      + 'per-second figure above, follow the total excursion above and the client tempo here.'
    : '';

  return block + rate;
}

// The whole rig in one table, on every wall's prompt. A wall generated as if it
// were alone is how a set stops stitching; seeing the other two in the same
// units is what keeps it one move. Built from the same rigspec call the wall's
// own block uses, so the two can never disagree — which the previous prose
// version did, describing "no camera motion at all" on all five walls for
// months because a rename left its lookup table behind.
function allWallsTable(moveId, durationSec, speedPct, centrePct) {
  const NL = String.fromCharCode(10);
  const rows = RIGSPEC.inspector(moveId, durationSec || 5, speedPct, centrePct);
  const lines = ['THE WHOLE RIG — one camera, one move, all three walls. Your wall is one view of this:'];
  lines.push('  wall     frame          dx over clip    scale over clip   direction');
  for (const r of rows) {
    lines.push('  ' + r.wall.padEnd(8) + r.framePx.padEnd(15)
      + r.dxTotal.padEnd(16) + r.scaleTotal.padEnd(18) + r.direction);
  }
  lines.push('Generate ONLY your own wall. The other rows are here so the three clips stitch into one');
  lines.push('continuous move, not so you draw them.');
  return lines.join(NL);
}

// The clause that exists because a centre wall came back with confetti and two
// extra characters that were never asked for. Invention scales with clip
// length, so it is stated as a hard budget rather than a preference.
function noInvention(wallId) {
  return 'NO NEW CONTENT. The supplied reference image is the complete inventory of this shot. Do not '
    + 'add any object, character, creature, vehicle, sign, text, logo, particle, confetti, sparkle, '
    + 'smoke, lens flare, light beam or weather that is not already visible in it. Do not remove '
    + 'anything either, and do not restyle, recolour or redesign anything. The ONLY new pixels allowed '
    + 'are the ones revealed at the frame edges by the camera move, and they must be a plain, quiet '
    + 'continuation of the material immediately adjacent to them. If the camera move reveals an area '
    + 'you have nothing to fill with, extend the existing ground, wall, sky or background rather than '
    + 'inventing a feature to occupy it. A frame that contains something the reference image did not is '
    + 'a failed frame, however good it looks.';
}

// Side walls are angled planes. Stated as a geometric expectation rather than a
// degree figure, so it stays true whatever the real chamfer turns out to be.
function perspective(wallId) {
  const sg = THEATRE.seg(wallId);
  if (wallId === 'center') {
    return 'PERSPECTIVE: the back plane of the room, seen square-on from the seat. Verticals stay '
         + 'vertical, the horizon runs level, no keystone.';
  }
  const deg = sg ? Math.abs(sg.angleDeg) : 90;
  const inner = wallId === 'left' ? 'RIGHT' : 'LEFT';
  const outer = wallId === 'left' ? 'LEFT' : 'RIGHT';
  return `PERSPECTIVE: this wall is a flat side plane at exactly ${deg} degrees to the centre wall — a `
    + `literal right-angle corner of a U-shaped room, seen from a seat in the middle. It is NOT a square-on `
    + `photo. The world recedes INTO `
    + `frame toward the ${inner} edge where this wall meets the centre — nearest and largest at the ${outer} `
    + `edge, shrinking toward the ${inner}. Whatever lines run along the wall's direction in this particular `
    + `scene — the edges of the ground plane, ridges, borders, rails, markings, the tops and bases of `
    + `whatever structures are present — must converge toward a vanishing point beyond the ${inner} edge, not `
    + `run flat. Horizon or eyeline stays level.`;
}

// --------------------------------------------------------- image composition ---
// Three modes, and the DEFAULT changed to 'extension' after a real failure: with
// the centre image attached as a reference, both side walls came back containing
// the centre's own billboard — the same LED screen, the same characters, the
// same signage — instead of the street continuing past it.
//
// The two older modes each get this wrong in opposite directions:
//   'distinct'  — "a genuinely different vantage point, do not repeat the
//                 landmark". Reads as permission to invent an unrelated place,
//                 and in practice the model copies the landmark anyway because
//                 the reference image is right there.
//   'panoramic' — "one continuous photograph sliced in three". Correct about
//                 continuity, but it invites the model to continue the SUBJECT
//                 too, which is how the billboard ended up on all three walls.
//
// 'extension' separates the two ideas that were tangled together: the WORLD is
// continuous, the SUBJECT is not. Same street, same block, same light, carrying
// on past the edge of frame — and the thing the centre is about appears exactly
// once, on the centre.
const IMAGE_MODES = {
  extension: 'Continuous extension — same world carries on, centre\'s subject does not repeat',
  panoramic: 'Panoramic — one photo sliced in three, everything continues',
  distinct: 'Distinct — each wall its own separate composition',
};

function imageComposition(wallId, mode) {
  const m = mode || 'extension';
  if (wallId === 'center') {
    if (m === 'extension') {
      return 'COMPOSITION: this is the CENTRE wall and the anchor of the set. It holds the subject — the '
        + 'landmark, the screen, the hero element the piece is about. The left and right walls continue '
        + 'this same place outward past the frame edges, so compose this one as the middle of a wider '
        + 'street or space that plainly carries on in both directions.';
    }
    return 'COMPOSITION: this is the CENTRE wall — the anchor the other two are measured against.';
  }
  const inner = wallId === 'left' ? 'RIGHT' : 'LEFT';
  const outer = wallId === 'left' ? 'LEFT' : 'RIGHT';
  const nb = wallId === 'left' ? 'left' : 'right';

  if (m === 'panoramic') {
    return `COMPOSITION: the ${nb} third of one continuous photograph spanning all three walls. Its `
      + `${inner} edge must continue seamlessly into the centre image's ${outer === 'LEFT' ? 'LEFT' : 'RIGHT'} `
      + `edge — an object crossing that seam is cut off here and picked up exactly where it left off there.

`
      + `SAME MEDIUM. The same rendering, line weight, detail level and palette as the centre image — `
      + `photographic, anime, vector, painterly or otherwise, take it from the reference. Never a photograph `
      + `beside a drawing.

`
      + `ONE HERO ONLY. Continuing the scene does NOT mean continuing the subject. The hero — the main `
      + `character, figure, product, display or landmark the piece is about — lives on the centre wall and `
      + `appears exactly once. No second or smaller version here, and no different hero of the same kind `
      + `added to balance it. Continue the setting, not the feature.`;
  }
  if (m === 'distinct') {
    return `COMPOSITION: a separate, self-contained photograph from a different vantage point in the same `
      + `setting. Do not reproduce the centre image's landmark, focal point or framing.`;
  }
  // extension — the default
  //
  // SCENE-AGNOSTIC BY CONSTRUCTION. An earlier version of this block described
  // the continuation in street furniture — kerbs, storefronts, traffic lights,
  // lamp posts — because it was written while looking at one urban reference.
  // That silently turned a universal rule into a scene brief: a centre frame of
  // a character on a sparkle background came back flanked by photoreal streets,
  // because the locked block *told* the model to draw a street. Nothing here may
  // name a subject, a setting or a medium. It may only describe the RELATIONSHIP
  // between this wall and whatever the centre happens to be.
  const outerWord = outer === 'LEFT' ? 'left' : 'right';
  // The centre image's edge that this wall butts against.
  const outerWordSeam = wallId === 'left' ? 'LEFT' : 'RIGHT';
  return `COMPOSITION — YOU ARE TURNING YOUR HEAD, NOT WIDENING THE SHOT. This is the single thing that `
    + `keeps coming back wrong, so read it twice.

`

    + `THE VIEWER DOES NOT MOVE. One person sits at one point in the middle of the room. The centre image `
    + `is what they see looking straight ahead. This wall is what the SAME person, from the SAME seat, sees `
    + `when they turn their head 90 degrees to the ${nb} and look along the side of the room. It is a `
    + `different DIRECTION from one place — exactly what a second camera at the same position, rotated 90 `
    + `degrees, would render.

`

    + `WHAT THAT RULES OUT. This is NOT a wider crop of the centre image. It is NOT the centre's view `
    + `pushed out or panned sideways. It does NOT show the centre's subject face-on again, smaller or `
    + `further away. If your frame looks like the centre image with more room around it, or shows the same `
    + `thing the centre shows from the same angle, it is wrong and must be redone. Someone shown the two `
    + `frames side by side must be able to say "that one is looking forward and that one is looking `
    + `sideways" without being told.

`

    + `WHERE THINGS GO. The centre's main subject sits STRAIGHT AHEAD of the viewer, which from this wall's `
    + `direction is off to the ${inner} — behind the edge of this frame. At most, its very edge may just `
    + `clip into this wall's extreme ${inner} edge, steeply foreshortened and seen almost edge-on. `
    + `Everything else in this frame is what runs ALONGSIDE the room: the side wall of the space, the side `
    + `of the crowd or street, the floor or ground running away from the viewer, and whatever structure, `
    + `surface or scenery lines that side. Near and large at the ${outer} edge, receding and small toward `
    + `the ${inner} edge where this wall meets the centre.

`

    + `THE SEAM STILL HAS TO MATCH. Where this wall's ${inner} edge meets the centre image's ${outerWordSeam} `
    + `edge, the two must line up as one continuous space: the same horizon or eyeline height, the same `
    + `floor or ground plane arriving at the same height and angle, the same light direction and colour, the `
    + `same medium and palette. Turning your head does not change the room you are in.

`

    + `MATCH THE MEDIUM. Whatever the centre image is made of, this wall is made of the same thing — `
    + `photographic, 3D render, cel or anime art, flat vector, painterly — with the same line weight, `
    + `outline treatment, detail level, palette and background treatment. Never a photograph beside a `
    + `drawing.

`

    + `ONE HERO, ONCE. The main character, figure, product, logo, display or landmark the piece is about `
    + `belongs to the centre wall and appears there only. Do not repeat it here, do not place a second or `
    + `smaller one further down, do not add a different one of the same kind to balance the frame, and do `
    + `not reproduce its artwork or lettering on any surface. This wall is the world around it.`;
}


// ===========================================================================
// PANORAMIC AND DISTINCT ARE THE OWNER'S OWN WORDING, VERBATIM.
//
// Both modes were dead: buildFixedImageRules in the page short-circuited on
// the server's imageRules before it ever looked at the mode, and the mode
// change never re-fetched them, so the dropdown moved and nothing else did.
// Now the mode is honoured, and these two return exactly the text supplied -
// no room brief, no principles preamble, no perspective essay bolted on.
// They are complete prompts as written and are not to be "improved".
//
// EXTENSION IS UNTOUCHED, by explicit instruction. It still goes through
// imageComposition() + buildImageLockedBlock() as it always has.
// ===========================================================================
const IMAGE_MODE_VERBATIM = {
  panoramic: {
    left: 'This is the LEFT wall - the left third of one continuous panoramic photograph that spans all three walls, as if a single very wide shot had been sliced into three vertical panels. Its LEFT edge is an outer edge of the full panorama (nothing to continue there), but its RIGHT edge must continue seamlessly into the CENTER wall\'s LEFT edge - the same object crossing that seam (a cloud, a mountain ridge, a shoreline, anything else spanning the boundary) should be visibly cut off by the frame here and picked up exactly where it left off in the center reference image, not restarted or redrawn differently. Match the exact same horizon line, camera height, lighting, and perspective as the center reference image - this should read as the left slice of ONE photograph, not an independent one.\n\nThis is a single static photograph, not a video and not a frame from one - there is no camera movement of any kind. The camera is completely locked in place: it does not move, pan, tilt, rotate, zoom, or change position at any point, before or during capture. One fixed, motionless viewpoint only.\n\nCamera framing: shoot straight-on, facing the scene directly and perpendicular to it - the environment should run roughly horizontally across the frame, not recede diagonally into the background at an angle. Pull the camera back for a generous distance from the main subject - a wide, spacious view with plenty of environment visible around it, not a close-up. Keep the horizon - the line where the ground or floor meets the back wall or background - low in the frame, at roughly 10% of the frame\'s height up from the bottom edge: most of the frame above that line is wall or background, with only a shallow band of ground or floor below it.',
    center: 'This is the CENTER wall - the middle third of one continuous panoramic photograph that spans all three walls, as if a single very wide shot had been sliced into three vertical panels. Its content must continue seamlessly into BOTH neighbors at the seams: whatever appears at this image\'s own LEFT edge must be the direct continuation of whatever appears at the LEFT wall\'s RIGHT edge - the same object, cut off by the frame in one image and picked up exactly where it left off in the other (for example, if a cloud, a mountain ridge, or a shoreline is only half-visible at the left wall\'s right edge, the rest of that same object continues here at this image\'s left edge, not a different or redrawn version of it) - and this image\'s own RIGHT edge must continue the same way into the RIGHT wall\'s LEFT edge. Match the exact same horizon line, camera height, lighting, and perspective across all three walls - this should read as three slices of ONE photograph, not three separate ones.\n\nThis is a single static photograph, not a video and not a frame from one - there is no camera movement of any kind. The camera is completely locked in place: it does not move, pan, tilt, rotate, zoom, or change position at any point, before or during capture. One fixed, motionless viewpoint only.\n\nCamera framing: shoot straight-on, facing the scene directly - the environment should run roughly horizontally across the frame, not recede diagonally into the background at an angle. Pull the camera back for a generous distance from the main subject - a wide, spacious view with plenty of environment visible around it, not a close-up.',
    right: 'This is the RIGHT wall - the right third of one continuous panoramic photograph that spans all three walls, as if a single very wide shot had been sliced into three vertical panels. Its RIGHT edge is an outer edge of the full panorama (nothing to continue there), but its LEFT edge must continue seamlessly into the CENTER wall\'s RIGHT edge - the same object crossing that seam (a cloud, a mountain ridge, a shoreline, anything else spanning the boundary) should be visibly cut off by the frame here and picked up exactly where it left off in the center reference image, not restarted or redrawn differently. Match the exact same horizon line, camera height, lighting, and perspective as the center reference image - this should read as the right slice of ONE photograph, not an independent one.\n\nThis is a single static photograph, not a video and not a frame from one - there is no camera movement of any kind. The camera is completely locked in place: it does not move, pan, tilt, rotate, zoom, or change position at any point, before or during capture. One fixed, motionless viewpoint only.\n\nCamera framing: shoot straight-on, facing the scene directly and perpendicular to it - the environment should run roughly horizontally across the frame, not recede diagonally into the background at an angle. Pull the camera back for a generous distance from the main subject - a wide, spacious view with plenty of environment visible around it, not a close-up. Keep the horizon - the line where the ground or floor meets the back wall or background - low in the frame, at roughly 10% of the frame\'s height up from the bottom edge: most of the frame above that line is wall or background, with only a shallow band of ground or floor below it.',
  },
  distinct: {
    left: 'This wall shows the view 90 degrees to the left of the center reference image\'s facing direction - a genuinely different vantage point, facing that way, not the same view continued or extended. Match the lighting, season or time of day, color palette, and overall mood of the attached center reference image - but this must be a distinct, self-contained composition of its own within that setting, not a continuation, extension, or wider crop of the center image\'s exact view. Do not repeat the center image\'s specific landmark, focal point, or its exact framing and horizon line - this should read as its own separate photograph, not a panoramic slice of the same shot.\n\nThis is a single static photograph, not a video and not a frame from one - there is no camera movement of any kind. The camera is completely locked in place: it does not move, pan, tilt, rotate, zoom, or change position at any point, before or during capture. One fixed, motionless viewpoint only.\n\nCamera framing: shoot straight-on, facing the scene directly and perpendicular to it - the environment should run roughly horizontally across the frame, not recede diagonally into the background at an angle. Pull the camera back for a generous distance from the main subject - a wide, spacious view with plenty of environment visible around it, not a close-up. Keep the horizon - the line where the ground or floor meets the back wall or background - low in the frame, at roughly 10% of the frame\'s height up from the bottom edge: most of the frame above that line is wall or background, with only a shallow band of ground or floor below it.',
    center: 'This is the CENTER wall - the anchor reference point that the left (-90 degrees) and right (+90 degrees) walls\' viewing directions are measured against; everything else in this three-wall composition pivots off this image.\n\nThis is a single static photograph, not a video and not a frame from one - there is no camera movement of any kind. The camera is completely locked in place: it does not move, pan, tilt, rotate, zoom, or change position at any point, before or during capture. One fixed, motionless viewpoint only.\n\nCamera framing: shoot straight-on, facing the scene directly - the environment should run roughly horizontally across the frame, not recede diagonally into the background at an angle. Pull the camera back for a generous distance from the main subject - a wide, spacious view with plenty of environment visible around it, not a close-up.',
    right: 'This wall shows the view 90 degrees to the right of the center reference image\'s facing direction - a genuinely different vantage point, facing that way, not the same view continued or extended. Match the lighting, season or time of day, color palette, and overall mood of the attached center reference image - but this must be a distinct, self-contained composition of its own within that setting, not a continuation, extension, or wider crop of the center image\'s exact view. Do not repeat the center image\'s specific landmark, focal point, or its exact framing and horizon line - this should read as its own separate photograph, not a panoramic slice of the same shot.\n\nThis is a single static photograph, not a video and not a frame from one - there is no camera movement of any kind. The camera is completely locked in place: it does not move, pan, tilt, rotate, zoom, or change position at any point, before or during capture. One fixed, motionless viewpoint only.\n\nCamera framing: shoot straight-on, facing the scene directly and perpendicular to it - the environment should run roughly horizontally across the frame, not recede diagonally into the background at an angle. Pull the camera back for a generous distance from the main subject - a wide, spacious view with plenty of environment visible around it, not a close-up. Keep the horizon - the line where the ground or floor meets the back wall or background - low in the frame, at roughly 10% of the frame\'s height up from the bottom edge: most of the frame above that line is wall or background, with only a shallow band of ground or floor below it.',
  },
};

function buildImageLockedBlock(wallId, mode, gradeRule, measuredRule) {
  const verbatim = IMAGE_MODE_VERBATIM[mode] && IMAGE_MODE_VERBATIM[mode][wallId];
  if (verbatim) return verbatim;

  const parts = [THEATRE.roomBrief(wallId), THEATRE_PRINCIPLES, imageComposition(wallId, mode), perspective(wallId),
                 'STILL FRAME: a single static photograph, no camera movement of any kind — one fixed, '
               + 'motionless viewpoint. Shoot straight-on rather than at an oblique angle, and pull back '
               + 'for a wide, spacious view rather than a close-up.'];
  if (gradeRule) parts.push(gradeRule);
  if (measuredRule) parts.push(measuredRule);
  return parts.join('\n\n');
}

// The JSON locked block. Same content as buildLockedBlock, in the shape the
// user's own working prompts used - because those prompts produced correct
// camera motion and the prose ones did not, repeatedly. Prose survives beside
// it for the on-screen "fixed rules" panel; JSON is what gets sent.
function buildLockedJson(wallId, rig, extras) {
  const moveId = RIGSPEC.normalise(rig && (rig.move || rig.intent));
  const dur = (rig && rig.durationSec) || 5;
  // The km/h box is a real control again: it is threaded into the contract
  // as a scene-scale reading of the same move. The measured frame figures
  // still govern - see rigspec.cameraJson.
  // The element's schedule is worked out BEFORE the camera block, because the
  // camera block's negatives have to know about it: four of them forbid exactly
  // what the element does, and left unqualified they cancel it out.
  const elSched = RIGSPEC.elementSchedule(
    Object.assign({}, rig, { durationSec: dur }), wallId);
  const base = RIGSPEC.cameraJson(moveId, wallId, dur, {
    speedPct: rig && Number(rig.speedPct),
    centrePct: rig && Number(rig.centrePct),
    element: elSched,
  });

  // ONE line about the room, not a section. The contract carried a room
  // description, a perspective essay and the wall energy law - 9.5KB in total
  // - and the delivered set ignored the terms that decide whether a clip is
  // usable, which were in the middle of it. rigspec.js already states this
  // wall's perspective in one sentence; the energy law is an operator rule
  // (it governs what we are willing to ship, not what the generator draws)
  // and lives in the inspector now.
  // Each wall is its own camera. The owner's note, and it is load-bearing:
  // told the three clips are "one camera", a generator has copied a
  // neighbour's screen direction onto a wall whose direction is the opposite
  // - which is how the right wall came back pushing in when it was asked to
  // push out. They share a rig, a moment and a look; they do not share a
  // direction.
  base.room = 'One of three walls of a U-shaped LED theatre, all seen from one seat in the middle. '
            + 'This wall is its own camera with its own frame: use ONLY the direction stated above '
            + 'and never copy the direction of another wall. The three cameras move as one rig, so '
            + 'the timing, the light and the style must match across all three.';

  // A decoded reference overrides the TEMPO only, never the geometry - the
  // geometry is the room's, the tempo is the client's. rig.decodedRate is set
  // by RIG.rigFromProbe() when a clip was actually measured (this used to be
  // read only by cameraTrack()/buildLockedBlock below, which nothing in the
  // real generation path calls - buildLockedJson's RIGSPEC.cameraJson() output
  // is what actually ships, so the note has to land here to ever be seen).
  if (rig && rig.speedInferred && rig.decodedRate && base.camera && base.camera.speed_note) {
    base.camera.speed_note += ' Decoded from the client reference clip: ' + rig.decodedRate + '.';
  }

  // THE TRAVELLING ELEMENT. This is the thing the theatre is actually for: one
  // object that crosses all three walls as a single continuous journey, so an
  // audience sitting in the middle follows it with their head instead of seeing
  // three unrelated clips.
  //
  // It never reached the generator. `choreographyRule` has computed these
  // timings since the butterfly was measured, but it is assembled into the
  // PROSE block, and prose is not what gets sent — the JSON contract is. So the
  // subject box and the rate box moved numbers around in a string nobody
  // transmitted, and each wall invented its own creature or none at all.
  //
  // The reference picture matters just as much: it rides along as an extra
  // --image, and without being told what it is, a model treats a second
  // attachment as more scene and paints it into the set.
  // THE TIMETABLE IS RIGSPEC'S, not recomputed here. Three places used to work
  // it out from the rate box and they did not agree, so the wall that mattered
  // got a window that fell outside its own clip. See rigspec.elementSchedule.
  const el = elSched;
  if (el) {
    // "5 large Owl" is five owls. The old wording answered that with "This is
    // ONE 5 large Owl", which tells the generator the count is both five and
    // one - and a count it cannot pin down is one it re-rolls per wall.
    const many = el.count && el.count > 1;
    const them = many ? 'all ' + el.count + ' of them' : 'it';
    const they = many ? 'they' : 'it';
    const noun = many ? el.subject : 'the ' + el.subject;

    base.travelling_element = {
      subject: el.subject,

      // THE TWO TIMES ARE THE WHOLE POINT, so they lead. The operator types them
      // per wall now; they are not derived from a pace box any more, and nothing
      // in here may round them off. Frames as well as seconds, because a frame
      // number is a thing you can be exactly right or exactly wrong about and
      // "about 2 seconds" is not.
      on_screen_exactly: 'Visible from ' + el.inAt + 's to ' + el.outAt + 's - frame '
        + el.inFrame + ' to frame ' + el.outFrame + ' of ' + el.lastFrame + '. These two times are '
        + 'fixed and are not a suggestion: frame ' + el.inFrame + ' is the FIRST frame any part of '
        + 'it is visible, frame ' + el.outFrame + ' is the LAST. Do not start it early, do not let '
        + 'it run on, do not ease it in or out.',
      enters: { edge: el.enterEdge, at_second: el.inAt, at_frame: el.inFrame },
      exits: { edge: el.exitEdge, at_second: el.outAt, at_frame: el.outFrame },
      crossing_time: el.onScreenSec + 's from edge to edge. Pace it so it is exactly clear of the '
        + el.exitEdge + ' edge at frame ' + el.outFrame + ' - not still leaving, not already long '
        + 'gone.',

      // WHERE IT IS, SECOND BY SECOND. Entry and exit times on their own were
      // read as loose cues and overrun every time: on the delivered set of
      // 2026-09-23 the right wall took its 2.0s entry exactly as asked and was
      // still showing the owls at 5.0s against a 2.95s exit. The camera half of
      // this contract is obeyed because it is given as a position at a time, so
      // the element is now given the same.
      x_path: el.xPath,
      x_path_key: '[seconds, x of its centre]. 0 = left edge, 1 = right edge; outside 0..1 is clear '
        + 'of frame. Hit these positions at these times - equal travel per equal slice of time, no '
        + 'acceleration and no hold.',

      not_in_frame: 'Frames 0-' + el.inFrame + ' (0-' + el.inAt + 's): completely absent - not '
        + 'partly in frame, not a shadow, not a silhouette, not blurred behind anything, not '
        + 'anywhere in the picture. Frames ' + el.outFrame + '-' + el.lastFrame + ' ('
        + el.outAt + '-' + el.durationSec.toFixed(1) + 's): gone, frame empty of it. It appears '
        + 'once, for ' + el.onScreenSec + 's, and at no other moment in this clip.',

      // COUNT AND SIZE, BOTH STATED. Neither used to be, and the delivered set
      // shows the cost: on one prompt and one reference picture the right wall
      // drew 2-4 small distant owls, the centre 3-4 mid-sized ones, and the left
      // wall a SINGLE bird in close-up filling half the frame.
      how_many: el.count != null
        ? 'Exactly ' + el.count + ', in every frame it appears and on all three walls.'
        : 'Exactly as many as the subject names - same number every frame, same number every wall.',
      size_in_frame: el.sizePctOfHeight + '% of the frame height, held at that size for the whole '
        + 'crossing. It crosses at a distance: never filling the frame, never cut off by the top or '
        + 'bottom edge, never coming nearer as it crosses.',
      height_in_frame: 'Its centre stays at ' + el.heightPctFromTop + '% of the frame height down '
        + 'from the top edge, level for the whole crossing - no rising, no dipping, no arc.',

      // THE ANIMATION IS THE SAME ON ALL THREE WALLS; ONLY THE TWO TIMES DIFFER.
      // Delivered 2026-09-23: the left wall drew one enormous owl low in frame,
      // the right wall a handful of small ones up near the horizon, and the two
      // read as different creatures on different journeys. Each wall is a
      // separate job that cannot see the others, so the invariants have to be
      // stated as absolutes rather than as "match the other walls" - there is no
      // other wall in front of it to match.
      same_on_every_wall: 'These are fixed values, identical in all three jobs, and none of them is '
        + 'yours to choose: the design and markings, the count, the size (' + el.sizePctOfHeight
        + '% of frame height), the height in frame (' + el.heightPctFromTop + '% from the top), the '
        + 'direction (' + el.enterEdge + ' to ' + el.exitEdge + '), a constant speed, and the same '
        + 'wing rhythm and body attitude throughout. Draw it exactly to these numbers.',
      only_difference: 'The ONLY thing that differs between the three walls is when it is on screen. '
        + 'On this wall that is ' + el.inAt + 's to ' + el.outAt + 's (frame ' + el.inFrame + ' to '
        + el.outFrame + ') and nothing else changes.',

      reference_image: el.refPath
        ? 'One attached image is this element alone. Copy its design, markings, colour and '
          + 'proportions exactly. Take nothing else from it: its background is not part of this set, '
          + 'and do NOT copy its framing or scale - that picture is a close-up, this is not.'
        : 'No picture supplied - take the design from the description, identical on every wall.',

      continuity: (el.index > 0
            ? 'Already mid-flight on arrival: at frame ' + el.inFrame + ' it is entering cut off by '
              + 'the ' + el.enterEdge + ' edge, never from a standstill. ' : '')
        + (el.index < el.lastIndex
            ? 'Carries on past this wall: at frame ' + el.outFrame + ' it is leaving cut off by the '
              + el.exitEdge + ' edge, never stopping, never fading out. ' : '')
        + 'Constant speed, height and SIZE across the frame - no pause, no hover, no reversing, no '
        + 'loop, no growing or shrinking.'
        + (many ? ' Formation and spacing hold, and the count never changes: ' + el.count + ' in, '
                + el.count + ' out.' : ''),

      independent_of_camera: 'The ONLY thing allowed to move on its own, and it is one leg of a '
        + 'single flight across all three walls. Everything else obeys the camera block.',
    };
    if (el.notes && el.notes.length) base.travelling_element.pacing_note = el.notes.join(' ');
  }

  if (extras && typeof extras === 'object') Object.assign(base, extras);
  return base;
}

function buildLockedBlock(wallId, rig, measuredRule) {
  const moveId = RIGSPEC.normalise(rig && (rig.move || rig.intent));
  const dur = (rig && rig.durationSec) || 5;
  const parts = [THEATRE.roomBrief(wallId), THEATRE_PRINCIPLES, cameraTrack(wallId, rig),
                 allWallsTable(moveId, dur, rig && rig.speedPct, rig && rig.centrePct), perspective(wallId), noInvention(wallId)];
  if (measuredRule) parts.push(measuredRule);
  return parts.join(String.fromCharCode(10) + String.fromCharCode(10));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
  IMAGE_MODE_VERBATIM, THEATRE_PRINCIPLES, cameraTrack, perspective, buildLockedBlock, buildLockedJson,
                     allWallsTable, noInvention,
                     imageComposition, buildImageLockedBlock, IMAGE_MODES,
                     ONE_RIG, PARALLAX, ENERGY, VECTION, SAFETY, CONTINUITY };
}
