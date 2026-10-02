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

GENERIC_NEG = ("text, letters, words, logo, watermark, signature, seam, vertical line, split screen, border, frame, "
               "collage, warped, distorted, mirrored copy, duplicate, blurry, low quality")
PHOTO_NEG = "cartoon, illustration, drawing, painting, anime, 3D render, CGI, " + GENERIC_NEG + ", noise, grain"
CARTOON_NEG = "photograph, photorealistic, realistic, 3D render, CGI, noise, grain, " + GENERIC_NEG
# Distinct walls: the corner returns are inpainted from both edges; keep their negative generic.
RET_NEG = ("seam, vertical line, white bar, white stripe, divider, border, frame, split screen, collage, blurry, "
           "low quality")

FIELDS = ["lead", "tail", "left_scene", "right_scene", "ret", "neg", "clean", "ret_neg"]


def has_key() -> bool:
    return bool(os.environ.get("ANTHROPIC_API_KEY", "").strip())


def template(style: str = "continue") -> dict:
    """Editable, scene-neutral prompts used when Claude isn't available."""
    lead = ("One continuous wide picture that carries straight on from the scene beside it, in exactly the same "
            "style and medium (a cartoon stays the same cartoon, a photograph stays the same photograph): the same "
            "light and time of day, the same sky, the same colours and the same kind of surroundings. Seen straight "
            "on with the same camera height and horizon: the ground line runs straight across the frame, level with "
            "the one beside it. No room corner, no new vanishing point.")
    if style == "distinct":
        left = ("Scene: another view of the same place, with its own subject that belongs there, in the same style, "
                "light and colours as the centre, the horizon at the same height.")
        right = ("Scene: a second, different view of the same place, with its own subject that belongs there, in the "
                 "same style, light and colours as the centre, the horizon at the same height.")
    else:
        left = ("Scene: the same place continues to the left, with more of the same surroundings, ground and sky "
                "running on at the same height and scale.")
        right = ("Scene: the same place continues to the right, with more of the same surroundings, ground and sky "
                 "running on at the same height and scale.")
    return dict(
        lead=lead,
        tail="Clean, crisp detail, deep focus.",
        left_scene=left,
        right_scene=right,
        ret="A narrow continuous strip of the same scene joining both sides seamlessly.",
        neg=GENERIC_NEG,
        clean="A clean, crisp image in the same style. Smooth clean colours, crisp detail, no noise, no grain, no pattern artifacts.",
        ret_neg=RET_NEG,
        summary="Template prompts (Claude wasn't used). They work for most pictures; you can edit them under Advanced.",
        art_style="unknown",
    )


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
3. No text or lettering anywhere: any sign, shopfront or poster shows only a simple picture, never writing. Keep \
"text, letters, words" in the negative.
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


def write_with_claude(centre: Image.Image, left_strip: Image.Image, right_strip: Image.Image, style: str) -> dict:
    import anthropic

    client = anthropic.Anthropic()  # reads ANTHROPIC_API_KEY from the environment
    content = [
        {"type": "text", "text": "The centre wall (2:1 crop as shown on the LED):"}, _b64(centre),
        {"type": "text", "text": "Left edge strip (the left wall and left corner are painted out from this):"}, _b64(left_strip),
        {"type": "text", "text": "Right edge strip (the right wall and right corner are painted out from this):"}, _b64(right_strip),
        {"type": "text", "text": ("Write the prompts for this room." + ("\n\n" + DISTINCT_NOTE if style == "distinct" else ""))},
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


def write(centre, left_strip, right_strip, style="continue") -> tuple[dict, str, str]:
    """Returns (prompts, source, note). source is 'claude' or 'template'."""
    if not has_key():
        return template(style), "template", "No Claude key is set, so template prompts were used."
    try:
        return write_with_claude(centre, left_strip, right_strip, style), "claude", ""
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
        return template(style), "template", f"Claude couldn't write the prompts ({msg}), so template prompts were used."
