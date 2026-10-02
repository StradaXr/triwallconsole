# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "fastapi>=0.110",
#   "uvicorn>=0.27",
#   "python-multipart>=0.0.9",
#   "pillow>=10",
#   "requests>=2.31",
#   "websocket-client>=1.7",
#   "anthropic>=0.70",
# ]
# ///
"""Tri-Wall Studio: drop in a centre picture, get the whole three-wall LED room back.

ComfyUI is the engine underneath (never shown to the user); Claude writes the prompts.
Run:  uv run server.py      then open http://127.0.0.1:8790
"""
import io
import json
import os
import random
import re
import threading
import time
import traceback
import zipfile
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageOps

import comfy
import prompts as P

HERE = Path(__file__).parent
PROJECTS = HERE / "projects"
STATIC = HERE / "static"
PORT = int(os.environ.get("TRIWALL_STUDIO_PORT", "8790"))
PROJECTS.mkdir(exist_ok=True)

# Room geometry at 2K (theatre.js, top-aligned on a 5760x1080 canvas): left | LR | centre | RR | right
ROOM_W, ROOM_H = 5760, 1080
PIECES = {  # name: (w, h, x) at 2K; 4K is exactly double
    "left": (1760, 800, 0),
    "LR": (160, 800, 1760),
    "centre": (1920, 960, 1920),
    "RR": (160, 800, 3840),
    "right": (1760, 800, 4000),
}
DEFAULT_SEEDS = {"left": 142, "right": 132, "LR": 301, "RR": 305}


def distinct_available() -> bool:
    return (comfy.CLAUDE_MCP / "distinct_workflow.py").exists()


# ----------------------------------------------------------------------------- projects
_settings_lock = threading.Lock()


def pdir(name: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9_\-]+", name or ""):
        raise HTTPException(400, "Bad project name")
    d = PROJECTS / name
    if not d.is_dir():
        raise HTTPException(404, "No such project")
    return d


def load(name: str) -> dict:
    return json.loads((pdir(name) / "settings.json").read_text(encoding="utf-8"))


def save(s: dict):
    with _settings_lock:
        p = PROJECTS / s["name"] / "settings.json"
        tmp = p.with_suffix(".tmp")
        tmp.write_text(json.dumps(s, indent=2, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, p)


def crop_box(w: int, h: int) -> tuple[int, int, int, int]:
    """The centred 2:1 crop the LED shows (same as ComfyUI ImageScale crop=center)."""
    if w / h > 2:
        cw = round(h * 2)
        x = (w - cw) // 2
        return x, 0, x + cw, h
    ch = round(w / 2)
    y = (h - ch) // 2
    return 0, y, w, y + ch


def centre_2k(s: dict) -> Image.Image:
    im = Image.open(PROJECTS / s["name"] / s["original"]).convert("RGB")
    return im.crop(tuple(s["crop"])).resize((1920, 960), Image.LANCZOS)


def compose_layout(s: dict, res: str = "2K") -> Path | None:
    d = PROJECTS / s["name"]
    k = 2 if res == "4K" else 1
    canvas = Image.new("RGB", (ROOM_W * k, ROOM_H * k), (0, 0, 0))
    any_piece = False
    for piece, (w, h, x) in PIECES.items():
        f = d / res / f"{piece}.png"
        if f.exists():
            canvas.paste(Image.open(f).convert("RGB").resize((w * k, h * k)), (x * k, 0))
            any_piece = True
    if not any_piece:
        return None
    out = d / ("room_layout.jpg" if res == "2K" else "room_layout_4k.jpg")
    canvas.save(out, quality=92)
    if res == "2K":
        thumb = canvas.copy()
        thumb.thumbnail((960, 960))
        thumb.save(d / "thumb.jpg", quality=85)
    return out


def crop_url(s: dict) -> str:
    """The 2:1 centre exactly as the LED shows it (1920x960), made once per project."""
    f = PROJECTS / s["name"] / "centre_2k_input.png"
    if not f.exists():
        centre_2k(s).save(f)
    return f"/projects/{s['name']}/centre_2k_input.png"


def public(s: dict) -> dict:
    """What the page needs (no internals)."""
    d = PROJECTS / s["name"]
    pieces = {}
    for piece in PIECES:
        f2, f4 = d / "2K" / f"{piece}.png", d / "4K" / f"{piece}.png"
        v = s.get("versions", {}).get(piece, 0)
        pieces[piece] = {
            "url": f"/projects/{s['name']}/2K/{piece}.png?v={v}" if f2.exists() else None,
            "url4k": f"/projects/{s['name']}/4K/{piece}.png?v={v}" if f4.exists() else None,
            "w": PIECES[piece][0], "h": PIECES[piece][1], "x": PIECES[piece][2], "version": v,
        }
    return {
        "name": s["name"], "title": s.get("title", s["name"]), "created": s.get("created"),
        "style": s.get("style", "continue"), "scene_type": scene_of(s), "medium": s.get("medium") or s.get("medium_guess") or "cartoon",
        "medium_guess": s.get("medium_guess"), "crop_url": crop_url(s), "original_url": f"/projects/{s['name']}/{s['original']}",
        "original_size": s["original_size"], "crop": s["crop"], "prompts": s.get("prompts"),
        "prompt_source": s.get("prompt_source"), "prompt_note": s.get("prompt_note", ""),
        "summary": (s.get("prompts") or {}).get("summary", ""), "pieces": pieces,
        "has_result": all(pieces[p]["url"] for p in PIECES), "has4k": bool(s.get("has4k")),
        "layout_url": f"/projects/{s['name']}/room_layout.jpg?v={sum(s.get('versions', {}).values())}"
        if (d / "room_layout.jpg").exists() else None,
    }


# ----------------------------------------------------------------------------- the one job at a time
JOB: dict = {"state": "idle"}
_job_lock = threading.Lock()


def report(**kw):
    kw = {k: v for k, v in kw.items() if v is not None}
    JOB.update(kw)


def start_job(project: str, kind: str, fn, *args):
    with _job_lock:
        if JOB.get("state") == "running":
            raise HTTPException(409, "Something is already being painted. Please wait for it to finish.")
        JOB.clear()
        JOB.update(state="running", project=project, kind=kind, stage="Getting ready", detail="", fraction=0.0,
                   started=time.time(), cancel=False, message="")

    def runner():
        try:
            msg = fn(*args)
            JOB.update(celebrate=True)
            JOB.update(state="done", stage="Done", detail="", fraction=1.0, message=msg or "", finished=time.time())
        except comfy.Cancelled:
            JOB.update(state="cancelled", stage="Stopped", detail="", finished=time.time())
        except Exception as e:
            traceback.print_exc()
            JOB.update(state="error", stage="Something went wrong", error=str(e)[:1500], finished=time.time())

    threading.Thread(target=runner, daemon=True).start()


def cancelled() -> bool:
    return bool(JOB.get("cancel"))


def scene_of(s: dict) -> str:
    return s.get("scene_type") if s.get("scene_type") in P.SCENE_TYPES else P.DEFAULT_SCENE


def gen_h(s: dict) -> int:
    return P.SCENE_TYPES[scene_of(s)]["gen_h"]


def build_preset(s: dict, comfy_centre: str) -> tuple[str, dict]:
    pr, seeds = s["prompts"], dict(s["seeds"])
    if s.get("style") == "distinct" and distinct_available():
        return "distinct", dict(
            centre=comfy_centre, tail=pr["tail"], scenes={"left": pr["left_scene"], "right": pr["right_scene"]},
            negs={"left": pr["neg"], "right": pr["neg"]}, ret=pr["ret"], ret_neg=pr.get("ret_neg") or P.RET_NEG,
            clean=pr["clean"], seeds=seeds, gen_h=gen_h(s), make_4k=False)
    return "fullset", dict(
        centre=comfy_centre, lead=pr["lead"], tail=pr["tail"], neg=pr["neg"], clean=pr["clean"],
        scenes={"left": pr["left_scene"], "right": pr["right_scene"]}, ret=pr["ret"], seeds=seeds,
        gen_h=gen_h(s), make_4k=False, joint_returns=True)


def seed_key(s: dict, piece: str) -> str:
    """Which seed repaints a piece. With joint returns (continue style) a return is painted with its wall."""
    if piece in ("LR", "RR") and not (s.get("style") == "distinct" and distinct_available()):
        return "left" if piece == "LR" else "right"
    return piece


# Every ComfyUI job is recorded in its project (settings["pending"]) the moment it is queued, so restarting the
# studio (closing the window, a crash) never loses a painting: on start-up the job is picked up again.
def tracked_run(s: dict, api: dict, kind: str, extra: dict, prompt_id: str | None = None) -> dict:
    d = PROJECTS / s["name"]
    (d / "pending_api.json").write_text(json.dumps(api), encoding="utf-8")
    live = d / "live"
    live.mkdir(exist_ok=True)

    def on_queued(pid):
        cur = load(s["name"])
        cur["pending"] = {"prompt_id": pid, "kind": kind, "extra": extra,
                          "queued": datetime.now().isoformat(timespec="seconds")}
        save(cur)

    def on_image(prefix, data):
        piece = prefix.replace("triwall_2k_", "")
        if piece in PIECES:
            (live / f"{piece}.png").write_bytes(data)
            JOB.setdefault("live", {})[piece] = f"/projects/{s['name']}/live/{piece}.png?t={int(time.time() * 1000)}"

    try:
        outs = comfy.run(api, report, cancelled, on_image=on_image, on_queued=on_queued, prompt_id=prompt_id)
    except comfy.Cancelled:
        _clear_pending(s["name"])
        raise
    except RuntimeError as e:
        if "lost this job" in str(e) or "hit a problem" in str(e):
            _clear_pending(s["name"])
        raise
    report(stage="Saving", detail="", fraction=0.99)
    return outs


def _clear_pending(name: str):
    cur = load(name)
    cur.pop("pending", None)
    save(cur)


def save_2k(s: dict, outs: dict):
    d = PROJECTS / s["name"]
    (d / "2K").mkdir(exist_ok=True)
    missing = [p for p in PIECES if not outs.get(f"triwall_2k_{p}")]
    if missing:
        raise RuntimeError("The painter finished but these pieces didn't come back: " + ", ".join(missing))
    for piece in PIECES:
        (d / "2K" / f"{piece}.png").write_bytes(outs[f"triwall_2k_{piece}"][-1])


def paint(s: dict, kind: str, extra: dict, swap: dict | None = None) -> dict:
    d = PROJECTS / s["name"]
    report(stage="Starting the painter", detail="")
    comfy.ensure_running()
    # The 2:1 centre is what goes on the LED; uploading it already cropped keeps everything consistent.
    up = d / "centre_2k_input.png"
    if not up.exists():
        centre_2k(s).save(up)
    comfy_centre = comfy.upload_image(up, f"tws_{s['name']}_centre.png")
    report(stage="Preparing the painting recipe")
    workflow, preset = build_preset(s, comfy_centre)
    api = comfy.build_api(workflow, preset)
    if swap and comfy.swap_seeds(api, swap) == 0:
        raise RuntimeError("Couldn't find the seed to change in the painting recipe.")
    return tracked_run(s, api, kind, extra)


def finish_make(name: str, outs: dict, extra: dict) -> str:
    s = load(name)
    save_2k(s, outs)
    s["versions"] = {p: s.get("versions", {}).get(p, 0) + 1 for p in PIECES}
    s["painted"] = datetime.now().isoformat(timespec="seconds")
    s["has4k"] = False
    s.pop("pending", None)
    save(s)
    _clear_4k(s)
    compose_layout(s)
    return "Your walls are ready."


def finish_reroll(name: str, outs: dict, extra: dict) -> str:
    s = load(name)
    piece, key, old, new = extra["piece"], extra["key"], extra["old"], extra["new"]
    save_2k(s, outs)
    s["seeds"][key] = new
    s.setdefault("seed_history", []).append({"piece": key, "old": old, "new": new})
    # Only pieces that depend on this seed get a new version number.
    changed = {key} | ({"LR"} if key == "left" else {"RR"} if key == "right" else set())
    s["versions"] = {p: s.get("versions", {}).get(p, 0) + (1 if p in changed else 0) for p in PIECES}
    s["has4k"] = False
    s.pop("pending", None)
    save(s)
    _clear_4k(s)
    compose_layout(s)
    nice = {"left": "left wall", "right": "right wall", "LR": "left corner", "RR": "right corner"}
    if key != piece:
        tail = f" Corners are painted together with their wall, so the {nice[key]} changed too."
    elif len(changed) > 1:
        tail = " Its corner was repainted to match."
    else:
        tail = ""
    return f"New version of the {nice[piece]} is ready.{tail}"


def finish_4k(name: str, outs: dict, extra: dict) -> str:
    s = load(name)
    d = PROJECTS / s["name"]
    (d / "4K").mkdir(exist_ok=True)
    for piece in extra["pieces"]:
        imgs = outs.get(f"triwall_studio_4k_{piece}")
        if not imgs:
            raise RuntimeError(f"The 4K {piece} didn't come back.")
        (d / "4K" / f"{piece}.png").write_bytes(imgs[-1])
    s["has4k"] = True
    s["approved"] = {"at": datetime.now().isoformat(timespec="seconds"), "seeds": s["seeds"], "versions": s["versions"]}
    s.pop("pending", None)
    save(s)
    compose_layout(s, "4K")
    return "4K files are ready to download."


FINISH = {"make": finish_make, "reroll": finish_reroll, "4k": finish_4k}


def job_make(name: str, style: str, use_prompts: dict | None, scene: str, medium: str):
    s = load(name)
    s["style"], s["scene_type"], s["medium"] = style, scene, medium
    if use_prompts:
        report(stage="Using your words")
        base = s.get("prompts") or P.template(style, scene, medium)
        base.update({k: v for k, v in use_prompts.items() if k in P.FIELDS and isinstance(v, str)})
        s["prompts"] = base
        s["prompt_note"] = "Painted with your edited prompts."
    else:
        report(stage="Looking at your picture")
        c = centre_2k(s)
        gh = gen_h(s)
        top = c.crop((0, 0, 1920, gh))
        left, right = top.crop((0, 0, 640, gh)), top.crop((1280, 0, 1920, gh))
        report(stage="Writing the scene" if P.has_key() else "Writing the scene (template)")
        pr, src, note = P.write(c, left, right, style, scene, medium)
        s["prompts"], s["prompt_source"], s["prompt_note"] = pr, src, note
    s.setdefault("seeds", dict(DEFAULT_SEEDS))
    save(s)
    return finish_make(name, paint(s, "make", {}), {})


def job_reroll(name: str, piece: str):
    s = load(name)
    key = seed_key(s, piece)
    old = s["seeds"][key]
    taken = set(s["seeds"].values())
    new = old
    while new in taken:
        new = random.randint(1000, 2**31 - 1)
    extra = {"piece": piece, "key": key, "old": old, "new": new}
    return finish_reroll(name, paint(s, "reroll", extra, swap={old: new}), extra)


def _clear_4k(s: dict):
    d = PROJECTS / s["name"] / "4K"
    if d.exists():
        for f in d.glob("*.png"):
            f.unlink()
    f = PROJECTS / s["name"] / "room_layout_4k.jpg"
    if f.exists():
        f.unlink()


def job_4k(name: str):
    s = load(name)
    d = PROJECTS / s["name"]
    report(stage="Starting the painter")
    comfy.ensure_running()
    (d / "4K").mkdir(exist_ok=True)
    items, local = [], set()
    cx0, cy0, cx1, cy1 = s["crop"]
    if cx1 - cx0 >= 3840 and cy1 - cy0 >= 1920:
        # The original is already big enough: take the 4K centre straight from it.
        Image.open(d / s["original"]).convert("RGB").crop(tuple(s["crop"])).resize((3840, 1920), Image.LANCZOS).save(d / "4K" / "centre.png")
        local.add("centre")
    report(stage="Sending the approved pictures")
    for piece, (w, h, _) in PIECES.items():
        if piece in local:
            continue
        name_in = comfy.upload_image(d / "2K" / f"{piece}.png", f"tws_{s['name']}_{piece}_2k_v{s['versions'].get(piece, 0)}.png")
        items.append((piece, name_in, 2 * w, 2 * h))
    extra = {"pieces": [i[0] for i in items]}
    return finish_4k(name, tracked_run(s, comfy.upscale_graph(items), "4k", extra), extra)


def job_resume(name: str):
    """Pick up a job that was queued before the studio was restarted."""
    s = load(name)
    pend = s["pending"]
    report(stage="Picking up where we left off")
    comfy.ensure_running()
    api = json.loads((PROJECTS / name / "pending_api.json").read_text(encoding="utf-8"))
    outs = tracked_run(s, api, pend["kind"], pend["extra"], prompt_id=pend["prompt_id"])
    return FINISH[pend["kind"]](name, outs, pend["extra"])


def resume_pending():
    """On start-up, the most recent project with a recorded, unfinished job is picked up again."""
    for d in sorted(PROJECTS.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
        f = d / "settings.json"
        if not f.exists():
            continue
        try:
            s = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        if s.get("pending") and (d / "pending_api.json").exists():
            try:
                start_job(s["name"], s["pending"]["kind"], job_resume, s["name"])
            except HTTPException:
                pass
            return


# ----------------------------------------------------------------------------- web app
app = FastAPI(title="Tri-Wall Studio")


@app.on_event("startup")
def _startup():
    threading.Thread(target=resume_pending, daemon=True).start()


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-store"})


@app.get("/app.css")
def app_css():
    return FileResponse(STATIC / "app.css", headers={"Cache-Control": "no-store"})


@app.get("/app.js")
def app_js():
    return FileResponse(STATIC / "app.js", headers={"Cache-Control": "no-store"})


@app.get("/api/status")
def status():
    return {"claude": P.has_key(), "distinct": distinct_available(), "engine": comfy.is_running(),
            "scene_types": {k: v["label"] for k, v in P.SCENE_TYPES.items()}, "default_scene": P.DEFAULT_SCENE,
            "model": P.MODEL}


@app.get("/api/projects")
def list_projects():
    out = []
    for d in sorted(PROJECTS.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
        f = d / "settings.json"
        if not f.exists():
            continue
        try:
            s = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        thumb = d / "thumb.jpg"
        out.append({"name": s["name"], "title": s.get("title", s["name"]), "created": s.get("created"),
                    "thumb": f"/projects/{s['name']}/thumb.jpg?v={int(thumb.stat().st_mtime)}" if thumb.exists()
                    else f"/projects/{s['name']}/{s['original']}", "done": thumb.exists(),
                    "has4k": bool(s.get("has4k"))})
    return out


@app.post("/api/projects")
async def new_project(file: UploadFile = File(...)):
    data = await file.read()
    try:
        im = Image.open(io.BytesIO(data))
        im = ImageOps.exif_transpose(im)
        im.load()
    except Exception:
        raise HTTPException(400, "That doesn't look like a picture. Try a PNG or JPG.")
    stem = Path(file.filename or "room").stem
    title = re.sub(r"[_\-]+", " ", stem).strip() or "My room"
    slug = re.sub(r"[^A-Za-z0-9]+", "-", stem).strip("-")[:40] or "room"
    name = f"{slug}-{datetime.now():%Y%m%d-%H%M%S}"
    d = PROJECTS / name
    d.mkdir(parents=True)
    im.convert("RGB").save(d / "centre_original.png")
    w, h = im.size
    try:
        medium = P.guess_medium(im.convert("RGB").crop(crop_box(w, h)))
    except Exception:
        medium = "cartoon"
    s = {"name": name, "title": title, "created": datetime.now().isoformat(timespec="seconds"),
         "original": "centre_original.png", "original_filename": file.filename, "original_size": [w, h],
         "crop": list(crop_box(w, h)), "style": "continue", "scene_type": P.DEFAULT_SCENE, "medium_guess": medium, "seeds": dict(DEFAULT_SEEDS), "versions": {},
         "prompts": None}
    save(s)
    return public(s)


@app.get("/api/projects/{name}")
def get_project(name: str):
    return public(load(name))


@app.post("/api/projects/{name}/make")
def make(name: str, body: dict):
    load(name)
    style = body.get("style", "continue")
    if style not in ("continue", "distinct") or (style == "distinct" and not distinct_available()):
        style = "continue"
    use_prompts = body.get("prompts") if body.get("use_my_prompts") else None
    scene = body.get("scene_type") if body.get("scene_type") in P.SCENE_TYPES else P.DEFAULT_SCENE
    medium = body.get("medium") if body.get("medium") in P.MEDIUMS else "cartoon"
    start_job(name, "make", job_make, name, style, use_prompts, scene, medium)
    return {"ok": True}


@app.post("/api/projects/{name}/reroll")
def reroll(name: str, body: dict):
    s = load(name)
    piece = body.get("piece")
    if piece not in ("left", "right", "LR", "RR"):
        raise HTTPException(400, "Only the walls and corners can be repainted; the centre is your picture.")
    if not s.get("prompts") or not public(s)["has_result"]:
        raise HTTPException(400, "Make the walls first.")
    start_job(name, "reroll", job_reroll, name, piece)
    return {"ok": True}


@app.post("/api/projects/{name}/make4k")
def make4k(name: str):
    if not public(load(name))["has_result"]:
        raise HTTPException(400, "Make the walls first.")
    start_job(name, "4k", job_4k, name)
    return {"ok": True}


@app.get("/api/job")
def job():
    j = {k: v for k, v in JOB.items() if k != "cancel"}
    if j.get("started"):
        j["elapsed"] = int((j.get("finished") or time.time()) - j["started"])
    return j


@app.post("/api/job/cancel")
def cancel_job():
    if JOB.get("state") == "running":
        JOB["cancel"] = True
    return {"ok": True}


@app.get("/api/projects/{name}/download")
def download(name: str):
    s = load(name)
    d = pdir(name)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for res, k in (("2K", 1), ("4K", 2)):
            for piece, (w, h, _) in PIECES.items():
                f = d / res / f"{piece}.png"
                if f.exists():
                    z.write(f, f"{res}/{piece}_{w * k}x{h * k}.png")
        if (d / "room_layout.jpg").exists():
            z.write(d / "room_layout.jpg", "room_layout.jpg")
        if (d / "room_layout_4k.jpg").exists():
            z.write(d / "room_layout_4k.jpg", "4K/room_layout_4k.jpg")
    return Response(buf.getvalue(), media_type="application/zip",
                    headers={"Content-Disposition": f'attachment; filename="{s["name"]}.zip"'})


app.mount("/projects", StaticFiles(directory=PROJECTS), name="projects")
app.mount("/static", StaticFiles(directory=STATIC), name="static")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
