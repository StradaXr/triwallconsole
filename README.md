# Tri-Wall Console

For the separate **Astra connected image workspace**, run
`npm run start:astra` and open http://localhost:8937/.
It connects to your signed-in Codex to draft, generate and refine directly
from the console, and stores its files locally. See [astra/README.md](astra/README.md).

TEST UPDATE

Generates the three wall videos for one camera move in a U-shaped LED immersive
theatre. A local Node server plus a single-page UI; it drives the Higgsfield
CLI for generation and a headless `claude` CLI for prompt writing.

**Everything below is either measured or was learned by shipping something that
failed. None of it is theory.** If you are a language model picking this up,
read sections 3, 4 and 5 before changing anything that reaches a generator.

---

## 1. Run it

```bash
npm install          # first time only
node server.js       # http://localhost:8934
```

Windows: `Launch Tri-Wall Console.bat`, or `launch.ps1`.

Needs on PATH: `node`, `python` (with `opencv-python` and `numpy`), the
Higgsfield CLI (`hf`), and the Claude CLI (`claude`). Both CLIs sign in through
their own browser flow — each person uses their own account. **This app never
asks for, stores or transmits a password, API key or token.**

`TRIWALL_PORT` changes the port. **`TRIWALL_STATE` changes the state file, and
you must set it for any second instance.** A different port is not a different
tool: both write the same `state.json`, and a test instance once wiped a live
scene because of exactly that.

### Which build am I looking at?

The masthead shows `build <id> · port <n>` and the folder it was served from.
The page also asks `/api/build` what is on disk and, if it is running something
else, reloads itself once through a cache-busting query. This exists because
three copies of this tool were once running from three folders and "it still
shows the old version" was unanswerable. If the stamp is not the folder you
think you are editing, you are on a different server.

---

## 2. The room

An 11520 x 2160 master canvas, five top-aligned segments:

| id | size | angle | role |
|---|---|---|---|
| L  | 3520 x 1600 | −90° | left wall |
| LR | 320 x 1600  | −45° | left corner return |
| C  | 3840 x 1920 | 0°   | centre wall |
| RR | 320 x 1600  | +45° | right corner return |
| R  | 3520 x 1600 | +90° | right wall |

nDisplay renders **three** views, each exactly one third of the canvas:
`L+LR = 3840`, `C = 3840`, `RR+R = 3840`. The tool generates L, C and R only —
the returns are a geometry problem a prompt cannot solve.

`theatre.js` is the single source of truth. Nothing downstream should contain a
literal `3520` again.

---

## 3. The camera moves, measured

The reference recordings (`C_PushIn.mp4`, `C_PushOut.mp4`, `C_TrackLeft.mp4`,
`C_TrackRight.mp4`) are **not in this repo** — they are client renders and stay
in the studio. Ask the owner for them; `rig_library.json` here holds the
measurements taken from them, and `learn_rig.py` rebuilds it if you have the
clips. Each is the whole 11520 x 2160 canvas scaled to 1920 x 1080: the
coloured strip sits at y 360..720 and splits into three exactly-640px panels,
which is the canvas at 1/6 scale. `learn_rig.py detect_panels()` finds them
from the green border rather than hard-coding, because hard-coded geometry
silently produced "no usable texture" on every clip the day they were
re-rendered.

Measured three independent ways — Farnebäck medians, sparse Lucas-Kanade
displacement, and a RANSAC similarity fit — agreeing to a few percent on all
twelve panel/move cells. **Totals over one reference gesture, in view widths,
+dx = the picture moves toward frame right:**

| move | L dx | L scale | C dx | C scale | R dx | R scale | T_ref |
|---|---|---|---|---|---|---|---|
| C_PushIn | −0.61 | ×1.10 | 0 | ×2.00 | +0.61 | ×1.10 | 1.93 s |
| C_PushOut | +0.61 | ×0.91 | 0 | ×0.50 | −0.61 | ×0.91 | 1.83 s |
| C_TrackLeft | +0.40 | ×2.30 | +0.59 | ×1.00 | +0.40 | ×0.435 | 1.60 s |
| C_TrackRight | −0.40 | ×0.435 | −0.59 | ×1.00 | −0.40 | ×2.30 | 1.70 s |

**C_PushOut.mp4 is literally C_PushIn.mp4 played backwards** — verified frame
by frame, mean pixel difference 0.80/255 against the reversed clip versus 42.04
forward. The two presets are exact inverses and must stay that way.

**Parallax on the side walls, measured:** the slowest decile of |dx| runs at
**0.75×** the frame median and the fastest at 1.2–1.7×, identically on both
moves and both walls. The far background is never still. Bands of
1.45 / 1.00 / 0.75 with a floor of 0.70. Do **not** quote an |dx| spread for the
centre as parallax — the centre's motion is radial scale, so that spread
measures distance from frame centre, not depth.

Two conversions and one rule:

* View widths → delivered wall: **×3840/3520 = 1.0909** for the sides; the
  centre needs none.
* **Scale by total excursion, never by per-second rate.** The references are
  ~1.7 s beats; copying their rate into a 5 s clip demands ~3× the travel.
* Landmark model, used by the prompt and the verifier alike:
  `x(t) = 0.5 + (x0 − 0.5)·scale^(t/T) + dx·(t/T)`

**Only C_PushIn and C_PushOut are offered.** Track, Turn, Tilt and Hold stay in
`rigmoves.MOVES` and `rig_library.json` so the decoder can still recognise them
in client footage and saved state naming one still resolves — they are just not
in the preset list (`PRESET_IDS` in `rigmoves.js`). Push out is push in played
backwards, and the two must stay exact inverses at every speed and duration.

---

## 4. Words that break generation

### The direction trap

Every "the direction is wrong" round came from the same mistake in different
words: **describing the camera when the generator renders the picture.**

* `pan_left_to_right` describes the CAMERA. A camera panning right makes the
  picture travel LEFT. A contract carrying both that key and a content-frame
  key got a push-out measured at **+0.137 on the right wall where the spec
  asked −0.665**, and **+0.015 on the left where it asked +0.665** — paralysed
  between the two.
* `expands outward` / `contracts inward` are also camera words. "Inward" reads
  as a push IN. The centre came back inverted on *both* presets: a push in
  rendered as a zoom out, and a push out measured ×1.37 against ×0.50.

**Never name the camera body. Describe what happens to the picture.**

* travel → the whole picture is *carried toward* an edge *as one locked piece*,
  plus a signed `dx_total` and a stated sign convention
* size → "everything gets BIGGER / SMALLER, the frame shows LESS / MORE of the
  scene, content runs off / new scene comes in at all four edges"

Physically: on a push in the side walls move **apart** — content travels from
the seam edge toward the outer edge on both sides, because you walk toward the
far wall and the side scenery flows backward past you.

Both readings are true at once and they are opposites, so the operator panel
prints them side by side (`rigspec.cameraGloss`) — camera tracking toward frame
RIGHT *is* the picture travelling toward frame LEFT. That string is **never
sent**.

### "Slide" is banned

Measured from paid output: the word makes individual objects slide across a
held background — the exact defect the contract exists to prevent. It reads as
something moving *on* a surface rather than the surface itself moving. It is
gone from every contract, **including from the negatives**, because a negative
still puts the word in front of the model.

---

## 5. JSON prompts, and why

The owner supplied seven hand-written prompts that produced correct camera
motion. Every one is JSON with an explicit camera block, `allow_*: false` locks
and a negative list. Prose — including numeric prose with velocities and a
timestamped landmark table — failed the same ways repeatedly. A model treats
prose as suggestion and a structured field as a constraint.

**The contract must stay small.** It grew to 9.5 KB across nine sections, and
the delivered set ignored the load-bearing terms — a wall zoomed 0.58 where the
contract said 1.00, rolled 8° where it said 0, and left its background at 5% of
the frame rate. Long inputs get the least attention in the middle, and that is
where the important constraints were. It is now ~3–4 KB with every key
load-bearing and ten negatives instead of fifty. **Do not let it grow back.**
Operator-facing material belongs in the inspector, not the prompt.

Merge order: the writer's scene draft goes in first, the locked contract **on
top**. A draft can add scene detail; it can never overwrite the camera.

**There is no local fallback for the camera rules, deliberately.** A JS copy of
them used to stand in until `/api/rig-rules` answered, which meant the page
showed retired rules for the first second of every load and a Generate pressed
in that window sent them. `fullVideoPrompt()` returns `null` when the contract
is missing and the Generate path refuses, spending nothing.

**Keep the preamble and the contract in step.** `JSON_PROMPT_PREFIX` named
`camera.landmark_clock`, `world_lock` and `negative_prompt` for weeks after
those keys were cut. The real ones are `checkpoints`, `landmarks`, `never`.

### CLI gotchas

**The CLI will not take bare JSON.** `hf generate create <model> --name value`
coerces each value against the model schema, JSON-parsing anything starting
with `{`, so a pure-JSON prompt arrives as an object:
`Invalid types: prompt should be string, got object`. Always put a line of
prose in front — `cliPromptArg()` in `server.js` is the backstop and covers all
three send paths.

**Use `hf generate cost` as a pre-flight.** Same validation as `create`, no job
created, free. It is wired in before every generation. It excludes media flags
to stay fast, which makes it blind to media-dependent constraints — see below.

**Mode constraints the pre-flight cannot see.** Seedance 2.5 defaults `mode` to
`t2v`, and this tool always sends the wall's plate:

```
mode t2v            + --image  ->  Error: mode 't2v' does not accept reference media
mode omni_reference + --image  ->  28 credits
```

Every centre and right wall was rejected this way. The server now reads the
model's own `mode` enum and switches `t2v → omni_reference` whenever media is
attached — not hardcoded to one model. `start_image`/`end_image` are also
`omni_reference`-only, and `extension_mode` is dropped unless the mode is
`video_extension`.

**Never use `--wait`** — one 4K job starves the shared queue for ~40 minutes.
`status: completed` is not correctness.

**Never say "Higgsfield", "tri-wall" or "three-wall" to the headless `claude`
CLI** — this org's account hijacks the call into an unauthorized connector, and
no flag overrides it. The instructions say "an AI image/video generator".

---

## 6. Speed is a rate, and clip length is separate

**Speed % and Clip seconds are independent.** Speed sets a per-second rate and
the clip length decides how long it runs, so

```
dx_total = dx_per_second x duration
```

One speed means the same pace at 4 s and at 15 s; a longer clip simply covers
more ground. Doubling the speed doubles the travel.

**100% is measured**, not a convention. Six operator reference clips
(`L_Clouds`, `R_Clouds`, `R_BLDG`, `L_grass`, `R_Desert`, `L_Desert`), each
measured twice — by `wall_motion.py` and by accumulated phase correlation. The
two estimators agreed on sign in all six and within 17% on magnitude:

| clip | wall_motion | phase-corr | mean \|dx\|/s |
|---|---|---|---|
| L_Clouds | 0.0026 | 0.0091 | 0.0059 |
| R_Clouds | 0.0072 | 0.0210 | 0.0141 |
| R_BLDG | 0.2349 | 0.2072 | 0.2211 |
| L_grass | 0.1439 | 0.1247 | 0.1343 |
| R_Desert | 0.0356 | 0.0294 | 0.0325 |
| L_Desert | 0.0990 | 0.1028 | 0.1009 |
| | | **mean** | **0.0848** |

Every `L_` clip travelled toward frame LEFT and every `R_` clip toward frame
RIGHT — six independent confirmations of the push-in topology in §3. The two
cloud clips sit far below the rest because their camera barely translates at
all; almost all their apparent motion is the cloud layer itself. Excluding them
gives 0.1222. The owner asked for all six averaged, so `BENCHMARK_DX_RATE` is
**0.0848 frame widths per second** on a side wall at 100%.

Cross-check: that benchmark puts the side walls' scale at ×1.0122/s, and the
six clips measured ×1.0113/s — agreement to 0.1%, which is the only reason the
centre's much larger scale is trusted to the same coupling.

**`refDur` is deliberately absent from the speed math.** `spec()` works in
gesture-fractions, so clip-trim length drops out algebraically. A pass that
divided by each move's own reference length made the two presets stop being
exact inverses (−0.424 against +0.447 on the same wall) purely because
`C_PushIn.mp4` is trimmed to 1.93 s and `C_PushOut.mp4` to 1.83 s. They are one
gesture played both ways — verified frame by frame in §3 — so that difference
is noise and must never reach the contract. dx is now exactly inverse; scale is
inverse to 0.06%, limited by the source table's independently measured
×1.10 / ×0.91 pair.

There is no km/h anywhere. It was never measurable — pixels carry no depth — and
it rode in the contract as an advisory string that governed nothing while
looking authoritative.

Both ends round to whole seconds. A first pass allowed 2.5 s and produced three
different durations at once — box 2.5, contract 2 (`readRigFromForm` parseInts
it), model field 3 — and a clip whose contract states a different length than
the model renders invalidates every checkpoint in the prompt.

**Every generation setting is shared across the three walls by default** —
whatever the selected model exposes (`aspect_ratio`, `bitrate_mode`,
`duration`, `resolution`, `quality`, ...): change it on one wall's card and it
mirrors onto the other two live, because a set generated at three different
resolutions is not a set. Governed by a **"link settings across walls"**
checkbox in the Image/Video generation section header, one per page, always
back on at page load — an unlinked wall left over from a previous visit is
exactly the silent drift this exists to prevent. Uncheck it to dial one wall
independently; re-checking it snaps all three back to the left wall's values
immediately. The wall's own prompt text and reference image are never
touched by this — only the model-parameter fields.

---

## 7. Image composition modes

Three modes, chosen globally: **extension** (assembled from
`principles.imageComposition`), **panoramic** and **distinct** (default —
each wall its own separate composition, sharing the reference's world, style,
light and palette but not its framing).

Panoramic and distinct return the owner's own wording **verbatim** from
`IMAGE_MODE_VERBATIM` in `principles.js` — no room brief, no principles
preamble, no perspective essay bolted on. They are complete prompts as written
and are not to be "improved". Extension is untouched by explicit instruction.

Both were dead for a while: `buildFixedImageRules` short-circuited on the
server's `imageRules` before it looked at the mode, and the dropdown never
re-fetched them. **Order matters** — POST the mode, re-fetch the rules, then
render.

---

## 8. When prompting is not enough

Seedance 2.5 accepts `start_image` **and** `end_image`. **Lock motion** builds
the clip's last frame from its first, applying the preset's own dx and scale,
and sends both — the travel becomes an interpolation rather than a request.
`make_end_frame.py`.

* Fill the revealed band by **edge replication, never mirroring.** Mirroring a
  66% translation copies whole objects into frame — the first version put a
  second booth in the shot.
* **Never lock a pure dolly.** Given a start and an end frame half the size,
  the centre held its first frame and stepped to the last: 1.00, 1.00, 1.00,
  0.95, 0.50, 0.49, 0.30. The endpoint refuses it now.
* **It costs in-scene animation**, so it is opt-in and visibly reversible. It
  was neither once, and a set went out locked that nobody had chosen to lock.

---

## 9. Verify, don't eyeball

**Check against preset** downloads the three finished clips, measures each with
`wall_motion.py` (a RANSAC similarity fit — the same model the spec is written
in) and compares **totals, not rates**. The old version compared a 5 s clip
against a 1.9 s reference's per-second rate, so a clip that obeyed the prompt
scored 40% and was reported "too weak" while one running 3× too far was a
"match".

`rigspec.compare()` holds the thresholds, next to the spec, so the check and
the instruction cannot drift apart. It catches wrong direction, under- and
over-travel, wrong-way zoom, an unrequested zoom, a rolled horizon, and "the
background is not moving with the camera" (`bgRatio` — only meaningful under
near-pure translation).

```bash
python wall_motion.py <clip.mp4>          # one finished wall
python learn_rig.py <dir-with-C_*.mp4>    # rebuild the reference library
```

**Screen recordings are poor data.** The player advances slower than the
capture, so a median over all frame pairs reads 0.000; repeating textures
defeat feature tracking entirely. Ask for the rendered clips.

---

## 10. State, history and the Library

`state.json` reached 836 KB, 795 KB of it version history — snapshots each
carrying their whole submitted prompt, some 16 KB apiece. Every `/api/state`
read shipped all of it. `pruneHistory()` caps it at 25 versions per wall and
2000 characters of stored prompt, on every save.

**`learning.pushVersion` unshifts — index 0 is the NEWEST version.** Anything
trimming history must slice from the front.

The **Library** tab is the permanent record: every finished generation, newest
first, streamed from its Higgsfield URL (`preload="none"` — a page of clips
must not fetch every file to draw a grid). Nothing is downloaded. It carries
wall, preset, model, resolution, duration and a ▲/▼ rating, and filters by
each. Ratings written here also update the version record so Statistics and the
calibrator agree.

If the local record is ever lost, **the generations are not**:
`hf generate list --size 100 --json` returns them from the account, and the
wall and preset can be parsed back out of each job's own prompt.

---

## 11. Files

| file | what it holds |
|---|---|
| `theatre.js` | the room: segments, sizes, angles. Source of truth. |
| `rigspec.js` | **the numbers.** Measured excursions, the JSON contract, the verifier thresholds, `cameraGloss`. Start here. |
| `rigmoves.js` | the C_* library and prose; `amplitudeLine` is retired, see its comment |
| `principles.js` | assembles the locked block; `IMAGE_MODE_VERBATIM` |
| `rig.js` | presets, fixed rules, travelling-element choreography |
| `server.js` | API, Higgsfield/Claude CLI calls, state, build stamp |
| `index.html` | the whole UI (Login / Image / Video / Library / Player / Statistics) |
| `learn_rig.py` | measures the reference renders into `rig_library.json` |
| `wall_motion.py` | measures one finished clip, in the spec's own units |
| `make_end_frame.py` | builds the end frame for the motion lock |
| `learning.js` | rating history and calibration; liked examples are keyed to the centre reference hash so they cannot bleed between scenes |

Not in the repo, by design: `state.json` (local, per machine), `uploads/`,
`outputs/`, `refs/`, `knowledge/` and the client reference renders. See
`.gitignore`.

---

## 12. Where it stands

Working: push-in on the side walls (confirmed by the owner); the image
prompter; the decoder; the preset inspector; the verifier; the Library; the
speed coupling.

Last measured delivered set (C_PushOut):

| wall | asked | got |
|---|---|---|
| left | dx +0.665 | **−0.007** — dead, third time |
| centre | ×0.50 | **×1.37** — inverted |
| right | dx −0.665, ×1.00 | −0.156, **×0.58**, roll −8.2°, bgRatio 0.05 |

The centre inversion is addressed by the `expand/contract` → `bigger/smaller`
rewrite in §4. The left wall has not responded to any prompt-level change;
**Lock motion** is the remaining lever and the verifier now names it. Neither
has been tested against a generation.

**Do not tell the owner something is fixed until a generation has been
measured.** That has been the recurring failure of this work, and it is worth
more than any individual bug fix: measure the output, quote the number, and say
plainly when it still does not match.
