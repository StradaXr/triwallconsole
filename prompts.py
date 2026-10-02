"""Writes the wall prompts. Claude (vision) looks at the centre and its two edge strips; without a key the
app falls back to editable template prompts so it still works.

The key is only ever read from the ANTHROPIC_API_KEY environment variable. It is never stored or logged.
"""
import base64
import io
import json
import os
import re

from PIL import Image

MODEL = "claude-opus-5-5"


def has_key() -> bool:
    return bool(os.environ.get("ANTHROPIC_API_KEY", "").strip())


# Negatives stay GENERIC: they never name a thing that could be visible in the centre's edge strips (the walls are
# painted out from those strips). "floor in perspective", "road" and "moon" in a negative made walls collapse into
# confetti whenever those things were in the strip (gaming room, graveyard). Medium words, quality words and
# "writing on signs" are safe.
_COMMON_NEG = ("blurry, low quality, gibberish text, writing on signs, letters, words, logo, watermark, signature, "
               "seam, vertical line, split screen, border, frame, collage, warped, distorted, mirrored copy, duplicate, "
               "people, crowd")
CARTOON_NEG = "photograph, photorealistic, realistic, 3D render, CGI, noise, grain, " + _COMMON_NEG
PHOTO_NEG = "cartoon, illustration, drawing, painting, anime, 3D render, CGI, plastic, oversaturated, " + _COMMON_NEG
# Distinct walls: the corner returns are inpainted from both edges; keep their negative generic.
RET_NEG = ("seam, vertical line, white bar, white stripe, divider, border, frame, split screen, collage, blurry, "
           "low quality")

FIELDS = ["lead", "tail", "left_scene", "right_scene", "ret", "neg", "clean", "ret_neg"]

# What's in the picture -> which template, and the generation height. 960 = paint at the centre's full height, so a
# floor or sidewalk line continues at the centre's height (presets_cartoon.py); the walls keep their top 800 rows.
SCENE_TYPES = {
    "room": {"label": "Room", "gen_h": 960},
    "street": {"label": "Street & town", "gen_h": 960},
    "city_water": {"label": "City & water", "gen_h": 960},
    "nature": {"label": "Nature", "gen_h": 800},
    "sky": {"label": "Sky only", "gen_h": 800},
}
DEFAULT_SCENE = "street"
MEDIUMS = ("cartoon", "photo")

_M = {
    "cartoon": dict(noun="cartoon illustration", style=", in the same hand-drawn 2D style with the same outlines and colouring",
                    tail="Clean, crisp hand-drawn cartoon illustration, the same colours, clean outlines.",
                    clean_end="Smooth clean colours, crisp outlines, no noise, no grain, no pattern artifacts.",
                    neg=CARTOON_NEG),
    "photo": dict(noun="photograph", style=", with the same lens, light and natural photographic detail",
                  tail="Sharp, rich photographic detail, deep focus.",
                  clean_end="Crisp natural detail on every surface, clean smooth sky, no noise, no grain, no pattern artifacts.",
                  neg=PHOTO_NEG),
}
_SAME = "in exactly the same style and medium as the picture beside it"
_SIGNS = (" Every shop sign, poster and banner shows only a simple picture (a cupcake, a flower, a toy, a star) and no "
          "writing at all.")


def _scene_text(scene: str, m: dict) -> dict:
    n = m["noun"]
    if scene == "room":
        return dict(
            lead=(f"One continuous wide {n} that carries straight on from the room beside it, {_SAME}{m['style']}: "
                  "the same room, the same wall colour and pattern, the same baseboard running straight across, the "
                  "same floor and the same light. Seen perfectly straight on, as a flat continuation of the same wall "
                  "plane at the same scale and the same camera height: the baseboard and the floor line continue "
                  "straight across at exactly the same height as in the picture beside it. No room corner, no side "
                  "wall, no ceiling, no door, no depth." + _SIGNS),
            left_scene=("Scene: the same wall continues to the left: a small shelf with a few books and toys, a framed "
                        "picture above it, and a soft rug on the same floor along the bottom."),
            right_scene=("Scene: the same wall continues to the right: a cosy armchair with a cushion, a small side "
                         "table with a lamp, and a potted plant on the same floor along the bottom."),
            ret="A narrow continuous strip of the same wall, baseboard and floor joining both sides seamlessly.",
            clean=f"A clean {n} of the same room, seen straight on.")
    if scene == "city_water":
        return dict(
            lead=(f"One continuous wide {n} that carries straight on from the waterside city beside it, {_SAME}"
                  f"{m['style']}: the same sky, the same calm water with soft reflections, the same waterside walls "
                  "and railings, the same trees and the same buildings in the same colours. Seen straight on with the "
                  "same camera height and horizon: the waterside wall and walkway run straight across the frame, level "
                  "with the ones beside it, and the water fills the bottom of the frame. No second canal, no new "
                  "vanishing point." + _SIGNS),
            left_scene=("Scene: the waterside city continues to the left: the walkway with railings runs on past a "
                        "small green park with round trees and a row of townhouses, with taller buildings behind and "
                        "the calm water in the foreground."),
            right_scene=("Scene: the waterside city continues to the right: the walkway with railings runs on past a "
                         "little cafe with an awning, a cosy house and round trees, with taller buildings behind and "
                         "the calm water across the bottom."),
            ret="A narrow continuous strip of the same water, walkway, buildings and sky joining both sides seamlessly.",
            clean=f"A clean {n} of a waterside city with trees and buildings.")
    if scene == "nature":
        return dict(
            lead=(f"One continuous wide {n} that carries straight on from the landscape beside it, {_SAME}"
                  f"{m['style']}: the same sky, the same light and time of day, the same ground, the same kind of "
                  "trees, plants and hills in the same colours. Seen straight on with the same camera height and "
                  "horizon: the ground line and the horizon run straight across the frame at exactly the same height "
                  "as in the picture beside it, and the ground fills the same part of the frame."),
            left_scene=("Scene: the landscape continues to the left: more of the same trees and bushes, a few rocks "
                        "and wild flowers on the same ground, and the same hills under the same sky."),
            right_scene=("Scene: the landscape continues to the right: a gentle rise with a cluster of the same trees, "
                         "tall grass and flowers on the same ground, and the same hills under the same sky."),
            ret="A narrow continuous strip of the same ground, trees and sky joining both sides seamlessly.",
            clean=f"A clean {n} of the same landscape.")
    if scene == "sky":
        return dict(
            lead=(f"One continuous wide {n} that carries straight on from the sky beside it, {_SAME}{m['style']}: the "
                  "same sky colours, the same light, the same kind of clouds at the same scale. Seen straight on with "
                  "the same camera height: the sky simply continues, with anything along the bottom edge at exactly "
                  "the same height as in the picture beside it."),
            left_scene="Scene: the same sky continues to the left, with more of the same soft clouds drifting across it.",
            right_scene="Scene: the same sky continues to the right, with a few more of the same clouds and the same light.",
            ret="A narrow continuous strip of the same sky joining both sides seamlessly.",
            clean=f"A clean {n} of the same sky.")
    # street & town (default)
    return dict(
        lead=(f"One continuous wide {n} that carries straight on from the street beside it, {_SAME}{m['style']}: the "
              "same town, the same sky, the same light, the same sidewalk and the same kind of shops, houses, "
              "street lamps, flower boxes and trees in the same colours. Seen straight on with the same camera height "
              "and horizon: the shopfronts and houses face the viewer in a row along the same sidewalk, which runs "
              "straight across the frame at exactly the same height as in the picture beside it, with no road or "
              "street turning off into the distance and no new vanishing point." + _SIGNS),
        left_scene=("Scene: the town continues to the left along the same sidewalk: a cheerful bakery facing the "
                    "viewer with a striped awning and a big cupcake picture on its sign, flower boxes full of flowers, "
                    "a street lamp, a wooden bench and round green trees, under the same sky."),
        right_scene=("Scene: the town continues to the right along the same sidewalk: a little toy shop facing the "
                     "viewer with a round window and a striped awning and a teddy-bear picture on its sign, planters "
                     "of colourful flowers, a street lamp and round green trees, under the same sky."),
        ret="A narrow continuous strip of the same street, sidewalk, buildings and sky joining both sides seamlessly.",
        clean=f"A clean {n} of a town street with shops facing the viewer.")


def template(style: str = "continue", scene: str = DEFAULT_SCENE, medium: str = "cartoon") -> dict:
    """Editable prompts used when Claude isn't available, one per kind of picture."""
    scene = scene if scene in SCENE_TYPES else DEFAULT_SCENE
    m = _M.get(medium, _M["cartoon"])
    t = _scene_text(scene, m)
    if style == "distinct":
        straight = ("seen straight on with the same camera height and horizon height as the centre, no new vanishing "
                    "point.")
        t["left_scene"] = (f"Scene: another view of the same place with its own subject that belongs there, in the "
                           f"same style, light and colours as the centre, " + straight + (_SIGNS if scene in ("street", "room", "city_water") else ""))
        t["right_scene"] = (f"Scene: a second, different view of the same place with its own subject that belongs "
                            f"there, in the same style, light and colours as the centre, " + straight)
    return dict(
        lead=t["lead"], tail=m["tail"], left_scene=t["left_scene"], right_scene=t["right_scene"], ret=t["ret"],
        neg=m["neg"], clean=t["clean"] + " " + m["clean_end"], ret_neg=RET_NEG,
        summary=f"Template words for a {SCENE_TYPES[scene]['label'].lower()} picture ({medium}). Claude wasn't used.",
        art_style=medium, scene_type=scene,
    )


def guess_medium(im: Image.Image) -> str:
    """Cheap cartoon/photo guess: photos carry fine grain in smooth areas, cartoons are cleaner.
    Only a strong grain signal says "photo"; busy, detailed cartoons overlap with photos below that. Measured on 10
    known centres: 8 right (all 5 cartoons; 3 of 5 photos; the 2 misses were photos guessed as cartoon). The picker
    shows the guess and the user confirms or changes it."""
    from PIL import ImageFilter
    g = im.convert("L")
    g.thumbnail((1024, 1024))
    a = list(g.getdata())
    med = list(g.filter(ImageFilter.MedianFilter(3)).getdata())
    edges = list(g.filter(ImageFilter.FIND_EDGES).getdata())
    smooth = [abs(x - y) >= 1 for x, y, e in zip(a, med, edges) if e < 12]
    jitter = sum(smooth) / max(1, len(smooth))
    return "photo" if jitter >= 0.45 else "cartoon"


SYSTEM = """You write image-generation prompts for a three-wall LED room. The centre wall shows an existing picture; \
the side walls are painted by an inpainting model (Qwen-Image) that continues outward from the centre's edge strips. \
You are shown the centre (already cropped to 2:1) and the two 640 px edge strips the walls are painted from.

Write prompts in the same style and length as these examples (a cartoon canal-city set):
LEAD: "One continuous wide cartoon illustration that carries straight on from the city beside it, in the same colourful \
hand-drawn 2D style with fine outlines: the same sunny cartoon canal city, the same bright light blue sky with a few \
small white cartoon clouds, the same calm light blue canal water with soft reflections, the same grey stone canal walls \
and railings, the same leafy green trees, and the same pastel buildings in pink, mint, cream and terracotta. Seen \
straight on with the same camera height and horizon: the canal wall and walkway run straight across the frame, level \
with the ones beside it, and the water fills the bottom of the frame."
TAIL: "Clean, crisp hand-drawn cartoon illustration, bright cheerful colours, fine outlines."
LEFT SCENE: "Scene: the canal city continues to the left: the canal bank and stone walkway with railings run on, with \
a small green park of round cartoon trees and a pink blossom tree, a little bandstand, a row of pastel townhouses and a \
glassy mint tower behind, and the calm blue canal water in the foreground."
RETURN: "A narrow continuous strip of the same canal, walkway, buildings and sky joining both sides seamlessly."
NEGATIVE: "people, crowd, night, dark sky, sunset, rain, snow, fog, vanishing point, second canal, photograph, \
photorealistic, realistic, 3D render, CGI, noise, grain, blurry, low quality, text, letters, words, logo, watermark, \
signature, seam, vertical line, split screen, border, frame, collage, warped, distorted, mirrored copy, duplicate"
CLEAN: "A clean hand-drawn 2D cartoon illustration of a sunny canal city with pastel buildings and green trees. Smooth \
bright colours, crisp fine outlines, no noise, no grain, no pattern artifacts."

Rules:
1. THE NEGATIVE MUST NEVER NAME ANYTHING VISIBLE IN EITHER EDGE STRIP - not an object, a creature, a colour that is \
present, a light source, a material or a weather. The walls are painted out from those strips; a negative that fights \
something visible there makes the model collapse (for example "moon" in the negative while a moon is in the strip \
ruins the wall). First list everything you can see in the two strips in visible_in_strips, then write a negative that \
shares no item with that list. Only name things that are absent and would be wrong (wrong time of day, wrong weather, \
wrong medium, crowds if there are none, duplicates, seams, text).
2. The walls are seen straight on, at the same camera height and the same horizon as the centre: the ground line, \
floor line or horizon continues straight across at exactly the same height. No room corners, no side walls, no new \
vanishing points, no roads or streets turning into the distance. Say this in the lead.
3. No text or lettering anywhere: every sign, shopfront, poster and banner shows only a simple picture (a cupcake, \
a flower, a toy), never writing. Say this in the lead and keep "gibberish text, writing on signs, letters, words" in the \
negative.
4. Keep the same art style and medium as the centre: if it is a photograph, every prompt says photograph and the \
negative rejects cartoon/illustration/3D; if it is a cartoon or illustration, the same cartoon style, and the negative \
rejects photograph/photorealistic/3D render.
5. Describe everything positively in the lead and scenes (no "no X" inside them, except the straight-on sentence). \
Give the left and right walls different things to show, both belonging to the centre's world, continuing from what \
each edge strip shows. Never repeat the centre's main subject on a wall.
6. The scenes start with "Scene:". Write in plain English that a non-expert can read and edit."""

DISTINCT_NOTE = """This set uses DISTINCT VIEWS: each side wall is its own picture of the same world (a different \
vantage with its own focal subject, never the centre's hero), generated with the centre as a style reference, joined \
to the centre only by the narrow corner returns. Write left_scene and right_scene as self-contained descriptions of \
those two views (each with its own focal subject), in the centre's style, light, palette, horizon height and camera \
height. The lead is not used for the walls in this mode but still write it."""

SCHEMA = {
    "type": "object",
    "properties": {
        "art_style": {"type": "string", "enum": ["photograph", "cartoon or illustration", "3D render", "painting"]},
        "visible_in_strips": {"type": "array", "items": {"type": "string"},
                              "description": "every thing visible in either edge strip, one or two words each"},
        "summary": {"type": "string", "description": "one friendly sentence for the user about what the walls will show"},
        "lead": {"type": "string"},
        "tail": {"type": "string"},
        "left_scene": {"type": "string"},
        "right_scene": {"type": "string"},
        "ret": {"type": "string"},
        "neg": {"type": "string"},
        "clean": {"type": "string"},
    },
    "required": ["art_style", "visible_in_strips", "summary", "lead", "tail", "left_scene", "right_scene", "ret",
                 "neg", "clean"],
    "additionalProperties": False,
}


def _b64(im: Image.Image, max_side=1568) -> dict:
    im = im.convert("RGB")
    im.thumbnail((max_side, max_side))
    buf = io.BytesIO()
    im.save(buf, format="JPEG", quality=90)
    return {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg",
                                        "data": base64.standard_b64encode(buf.getvalue()).decode()}}


def scrub_negative(neg: str, visible: list[str]) -> tuple[str, list[str]]:
    """Belt and braces for rule 1: drop any negative term that shares a word with something visible."""
    stop = {"the", "and", "with", "small", "large", "big", "little", "some", "few", "distant", "far", "near", "soft",
            "bright", "dark", "light", "pale", "deep", "tall", "low", "high", "long", "short", "wide", "narrow", "edge",
            "top", "bottom", "left", "right", "part", "partial", "cartoon", "style"}
    words = set()
    for v in visible:
        for w in re.findall(r"[a-z]+", v.lower()):
            if len(w) > 2 and w not in stop:
                words.add(w)
                words.add(w.rstrip("s"))
    keep, dropped = [], []
    protected = {"text", "letters", "words", "logo", "watermark", "seam", "border", "frame", "blurry", "quality"}
    for term in [t.strip() for t in neg.split(",") if t.strip()]:
        tw = {w for w in re.findall(r"[a-z]+", term.lower()) if w not in stop}
        tw |= {w.rstrip("s") for w in tw}
        if (tw & words) and not (tw & protected):
            dropped.append(term)
        else:
            keep.append(term)
    return ", ".join(keep), dropped


def write_with_claude(centre: Image.Image, left_strip: Image.Image, right_strip: Image.Image, style: str,
                      scene: str = DEFAULT_SCENE, medium: str = "cartoon") -> dict:
    import anthropic

    client = anthropic.Anthropic()  # reads ANTHROPIC_API_KEY from the environment
    content = [
        {"type": "text", "text": "The centre wall (2:1 crop as shown on the LED):"}, _b64(centre),
        {"type": "text", "text": "Left edge strip (the left wall and left corner are painted out from this):"}, _b64(left_strip),
        {"type": "text", "text": "Right edge strip (the right wall and right corner are painted out from this):"}, _b64(right_strip),
        {"type": "text", "text": (f"The person says the picture shows: {SCENE_TYPES.get(scene, SCENE_TYPES[DEFAULT_SCENE])['label']}, "
                                  f"and that it is a {medium}. Write the prompts for this room."
                                  + ("\n\n" + DISTINCT_NOTE if style == "distinct" else ""))},
    ]
    kwargs = dict(model=MODEL, max_tokens=16000, system=SYSTEM, messages=[{"role": "user", "content": content}],
                  thinking={"type": "adaptive"}, output_config={"effort": "high", "format": {"type": "json_schema", "schema": SCHEMA}})
    try:
        # Server-side refusal fallback (beta): a declined request is retried on Anthropic's recommended model.
        resp = client.beta.messages.create(betas=["server-side-fallback-2026-07-01"], fallbacks="default", **kwargs)
    except (anthropic.BadRequestError, TypeError):
        resp = client.messages.create(**kwargs)
    if resp.stop_reason == "refusal":
        raise RuntimeError("Claude declined to describe this picture.")
    if resp.stop_reason == "max_tokens":
        raise RuntimeError("Claude's answer was cut off.")
    text = next(b.text for b in resp.content if b.type == "text")
    d = json.loads(text)
    neg, dropped = scrub_negative(d["neg"], d.get("visible_in_strips", []))
    d["neg"] = neg
    d["ret_neg"] = RET_NEG
    d["dropped_from_negative"] = dropped
    return d


def write(centre, left_strip, right_strip, style="continue", scene=DEFAULT_SCENE, medium="cartoon") -> tuple[dict, str, str]:
    """Returns (prompts, source, note). source is 'claude' or 'template'."""
    if not has_key():
        return template(style, scene, medium), "template", "No Claude key is set, so template words were used."
    try:
        return write_with_claude(centre, left_strip, right_strip, style, scene, medium), "claude", ""
    except Exception as e:  # never stop the user; fall back to templates
        msg = type(e).__name__
        try:
            import anthropic
            if isinstance(e, anthropic.AuthenticationError):
                msg = "the Claude key was not accepted"
            elif isinstance(e, anthropic.RateLimitError):
                msg = "Claude is busy right now"
            elif isinstance(e, anthropic.APIConnectionError):
                msg = "couldn't reach Claude (are you online?)"
            elif isinstance(e, RuntimeError):
                msg = str(e)
        except Exception:
            pass
        return template(style, scene, medium), "template", f"Claude couldn't write the prompts ({msg}), so template words were used."
