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
        "style": s.get("style", "continue"), "original_url": f"/projects/{s['name']}/{s['original']}",
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


def build_preset(s: dict, comfy_centre: str) -> tuple[str, dict]:
    pr, seeds = s["prompts"], dict(s["seeds"])
    if s.get("style") == "distinct" and distinct_available():
        return "distinct", dict(
            centre=comfy_centre, tail=pr["tail"], scenes={"left": pr["left_scene"], "right": pr["right_scene"]},
            negs={"left": pr["neg"], "right": pr["neg"]}, ret=pr["ret"], ret_neg=pr.get("ret_neg") or P.RET_NEG,
            clean=pr["clean"], seeds=seeds, make_4k=False)
    return "fullset", dict(
        centre=comfy_centre, lead=pr["lead"], tail=pr["tail"], neg=pr["neg"], clean=pr["clean"],
        scenes={"left": pr["left_scene"], "right": pr["right_scene"]}, ret=pr["ret"], seeds=seeds,
        gen_h=960, make_4k=False, joint_returns=True)


def seed_key(s: dict, piece: str) -> str:
    """Which seed repaints a piece. With joint returns (continue style) a return is painted with its wall."""
    if piece in ("LR", "RR") and not (s.get("style") == "distinct" and distinct_available()):
        return "left" if piece == "LR" else "right"
    return piece


def paint(s: dict, swap: dict | None = None, label: str = "") -> str:
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
    if swap:
        if comfy.swap_seeds(api, swap) == 0:
            raise RuntimeError("Couldn't find the seed to change in the painting recipe.")
    live = d / "live"
    live.mkdir(exist_ok=True)

    def on_image(prefix, data):
        piece = prefix.replace("triwall_2k_", "")
        if piece in PIECES:
            stamp = int(time.time() * 1000)
            (live / f"{piece}.png").write_bytes(data)
            JOB.setdefault("live", {})[piece] = f"/projects/{s['name']}/live/{piece}.png?t={stamp}"

    outs = comfy.run(api, report, cancelled, on_image=on_image)
    report(stage="Saving", detail="", fraction=0.99)
    (d / "2K").mkdir(exist_ok=True)
    got = []
    for piece in PIECES:
        imgs = outs.get(f"triwall_2k_{piece}")
        if imgs:
            (d / "2K" / f"{piece}.png").write_bytes(imgs[-1])
            got.append(piece)
    missing = [p for p in PIECES if p not in got]
    if missing:
        raise RuntimeError("The painter finished but these pieces didn't come back: " + ", ".join(missing))
    return got


def job_make(name: str, style: str, use_prompts: dict | None):
    s = load(name)
    s["style"] = style
    if use_prompts:
        report(stage="Using your words")
        base = s.get("prompts") or P.template(style)
        base.update({k: v for k, v in use_prompts.items() if k in P.FIELDS and isinstance(v, str)})
        s["prompts"] = base
        s["prompt_note"] = "Painted with your edited prompts."
    else:
        report(stage="Looking at your picture")
        c = centre_2k(s)
        gh = 960 if style != "distinct" else 800
        top = c.crop((0, 0, 1920, gh))
        left, right = top.crop((0, 0, 640, gh)), top.crop((1280, 0, 1920, gh))
        report(stage="Writing the scene" if P.has_key() else "Writing the scene (template)")
        pr, src, note = P.write(c, left, right, style)
        s["prompts"], s["prompt_source"], s["prompt_note"] = pr, src, note
    s.setdefault("seeds", dict(DEFAULT_SEEDS))
    s["has4k"] = False
    save(s)
    paint(s)
    s["versions"] = {p: s.get("versions", {}).get(p, 0) + 1 for p in PIECES}
    s["painted"] = datetime.now().isoformat(timespec="seconds")
    save(s)
    _clear_4k(s)
    compose_layout(s)
    return "Your walls are ready."


def job_reroll(name: str, piece: str):
    s = load(name)
    key = seed_key(s, piece)
    old = s["seeds"][key]
    taken = set(s["seeds"].values())
    new = old
    while new in taken:
        new = random.randint(1000, 2**31 - 1)
    got = paint(s, swap={old: new})
    s = load(name)
    s["seeds"][key] = new
    s.setdefault("seed_history", []).append({"piece": key, "old": old, "new": new})
    # Only pieces that actually depend on this seed get a new version number.
    changed = {key}
    if key == "left":
        changed.add("LR")
    if key == "right":
        changed.add("RR")
    s["versions"] = {p: s.get("versions", {}).get(p, 0) + (1 if p in changed else 0) for p in PIECES}
    s["has4k"] = False
    save(s)
    _clear_4k(s)
    compose_layout(s)
    nice = {"left": "left wall", "right": "right wall", "LR": "left corner", "RR": "right corner"}
    if key != piece:
        extra = f" Corners are painted together with their wall, so the {nice[key]} changed too."
    elif len(changed) > 1:
        extra = f" Its corner was repainted to match."
    else:
        extra = ""
    return f"New version of the {nice[piece]} is ready.{extra}"


def _clear_4k(s: dict):
    d = PROJECTS / s["name"] / "4K"
    if d.exists():
        for f in d.glob("*.png"):
            f.unlink()


def job_4k(name: str):
    s = load(name)
    d = PROJECTS / s["name"]
    report(stage="Starting the painter")
    comfy.ensure_running()
    (d / "4K").mkdir(exist_ok=True)
    items, local = [], {}
    ow, oh = s["original_size"]
    cx0, cy0, cx1, cy1 = s["crop"]
    if cx1 - cx0 >= 3840 and cy1 - cy0 >= 1920:
        # The original is already big enough: take the 4K centre straight from it.
        Image.open(d / s["original"]).convert("RGB").crop(tuple(s["crop"])).resize((3840, 1920), Image.LANCZOS).save(d / "4K" / "centre.png")
        local["centre"] = True
    report(stage="Sending the approved pictures")
    for piece, (w, h, _) in PIECES.items():
        if piece in local:
            continue
        name_in = comfy.upload_image(d / "2K" / f"{piece}.png", f"tws_{s['name']}_{piece}_2k_v{s['versions'].get(piece, 0)}.png")
        items.append((piece, name_in, 2 * w, 2 * h))
    outs = comfy.run(comfy.upscale_graph(items), report, cancelled)
    for piece, *_ in items:
        imgs = outs.get(f"triwall_studio_4k_{piece}")
        if not imgs:
            raise RuntimeError(f"The 4K {piece} didn't come back.")
        (d / "4K" / f"{piece}.png").write_bytes(imgs[-1])
    s["has4k"] = True
    s["approved"] = {"at": datetime.now().isoformat(timespec="seconds"), "seeds": s["seeds"], "versions": s["versions"]}
    save(s)
    compose_layout(s, "4K")
    return "4K files are ready to download."


# ----------------------------------------------------------------------------- web app
app = FastAPI(title="Tri-Wall Studio")


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
    s = {"name": name, "title": title, "created": datetime.now().isoformat(timespec="seconds"),
         "original": "centre_original.png", "original_filename": file.filename, "original_size": [w, h],
         "crop": list(crop_box(w, h)), "style": "continue", "seeds": dict(DEFAULT_SEEDS), "versions": {},
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
    start_job(name, "make", job_make, name, style, use_prompts)
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
