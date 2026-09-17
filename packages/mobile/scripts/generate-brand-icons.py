"""
Regenerates the Orbit brand icon/splash/favicon artwork from the same construction as the in-app
animated OrbitMark (src/components/ui/BrandMark.tsx): two rings, two satellite dots frozen at a
chosen angle, a soft core glow (a true per-pixel radial gradient via numpy, smoother than
GlowBlob's stacked-disc approximation, which bands visibly at icon resolution), and the company's
sumeru-logo.png inlaid at the core.

Run this again if the brand palette (tokens.ts) or the sumeru logo asset ever changes — it's the
one script that keeps app.config.js's icon/splash/favicon in sync with the in-app identity.
Everything here is plain filled circles/rings (no SVG/gradient library, matching the rest of the
app's own constraint), supersampled 4x and downsampled with LANCZOS for anti-aliasing.

Usage: python3 scripts/generate-brand-icons.py   (run from packages/mobile)
Requires: pillow, numpy (not app runtime deps — dev-machine only, e.g. `pip3 install pillow numpy`).
"""
import math
import os
import numpy as np
from PIL import Image, ImageDraw

ASSETS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets")
LOGO_PATH = f"{ASSETS}/sumeru-logo.png"

BG = (10, 16, 28, 255)          # #0A101C — "Orbit Navy" ground
VIOLET = (47, 125, 255)         # #2F7DFF primary (electric blue; kept the variable name so the
                                # rest of this file — written for a violet primary — needs no
                                # other edits when the palette moves again)
CYAN = (45, 212, 191)           # #2DD4BF accent (electric teal)

SS = 4  # supersample factor


def hex_alpha(rgb, alpha_255):
    return (*rgb, alpha_255)


def draw_glow(base, center, max_diam, color, opacity, power=1.6):
    """A true radial gradient (computed per-pixel with numpy) rather than GlowBlob's stacked-disc
    approximation — that trick reads fine as a faint UI wash at small scale, but at icon
    resolution the individual discs show as visible banding. Same visual intent (soft centre,
    fading to nothing), smoother result."""
    w, h = base.size
    cx, cy = center
    r = max_diam / 2
    # Bounding box to keep the numpy grid small — the glow is fully transparent past `r` anyway.
    x0, y0 = max(0, int(cx - r)), max(0, int(cy - r))
    x1, y1 = min(w, int(cx + r)), min(h, int(cy + r))
    if x1 <= x0 or y1 <= y0:
        return
    ys, xs = np.mgrid[y0:y1, x0:x1]
    dist = np.sqrt((xs - cx) ** 2 + (ys - cy) ** 2) / r
    alpha = np.clip(1.0 - dist, 0.0, 1.0) ** power * opacity
    alpha_u8 = (alpha * 255).astype(np.uint8)

    layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
    patch = Image.fromarray(alpha_u8, mode="L")
    color_patch = Image.new("RGBA", patch.size, (*color, 255))
    color_patch.putalpha(patch)
    layer.paste(color_patch, (x0, y0))
    base.alpha_composite(layer)


def draw_ring(base, center, diameter, color, alpha_255, stroke):
    cx, cy = center
    r = diameter / 2
    layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
    ld = ImageDraw.Draw(layer)
    ld.ellipse([cx - r, cy - r, cx + r, cy + r], outline=hex_alpha(color, alpha_255), width=stroke)
    base.alpha_composite(layer)


def draw_satellite(base, center, orbit_diameter, angle_deg, dot_diameter, color, border_color, border_w):
    cx, cy = center
    orbit_r = orbit_diameter / 2
    rad = math.radians(angle_deg)
    sx = cx + orbit_r * math.cos(rad)
    sy = cy - orbit_r * math.sin(rad)  # image y grows downward; flip for standard math angle
    dr = dot_diameter / 2
    layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
    ld = ImageDraw.Draw(layer)
    if border_w > 0:
        ld.ellipse([sx - dr - border_w, sy - dr - border_w, sx + dr + border_w, sy + dr + border_w],
                   fill=hex_alpha(border_color, 255))
    ld.ellipse([sx - dr, sy - dr, sx + dr, sy + dr], fill=hex_alpha(color, 255))
    base.alpha_composite(layer)


def build_mark(canvas_px, outer_diam_frac, with_ambient_halo, ring_stroke_frac, sat_frac, opaque_bg):
    """One frozen frame of the Orbit mark, rendered at `canvas_px` (already supersampled)."""
    size = canvas_px * SS
    img = Image.new("RGBA", (size, size), BG if opaque_bg else (0, 0, 0, 0))
    center = (size / 2, size / 2)
    outer = size * outer_diam_frac
    inner = outer * 0.62
    core = outer * 0.32

    if with_ambient_halo:
        draw_glow(img, center, outer * 1.35, VIOLET, 0.14)

    # core breathing glow, behind the logo
    draw_glow(img, center, core * 1.9, VIOLET, 0.5)

    # rings — bold strokes rather than a literal 1:1 scale of the 1.5pt UI hairline, which would
    # vanish (or look accidental) at icon scale.
    stroke = max(2, int(outer * ring_stroke_frac))
    draw_ring(img, center, outer, VIOLET, 140, stroke)
    draw_ring(img, center, inner, CYAN, 125, stroke)

    # satellites, frozen mid-orbit instead of mid-animation. Angles chosen so the outer (cyan)
    # dot sits upper-right and the inner (violet) dot sits lower-left — a balanced diagonal,
    # matching how the live animated mark reads at a natural resting moment.
    sat_outer_d = outer * sat_frac
    sat_inner_d = outer * (sat_frac * 0.7)
    border = max(2, int(sat_outer_d * 0.18))
    draw_satellite(img, center, outer, 52, sat_outer_d, CYAN, BG[:3], border)
    draw_satellite(img, center, inner, 235, sat_inner_d, VIOLET, BG[:3], 0)

    # the company's own mark at the core, 13:10 ratio (matches its 208x160 asset), inset inside
    # the inner ring so it never overlaps the satellites.
    logo = Image.open(LOGO_PATH).convert("RGBA")
    logo_w = core * 1.56
    logo_h = core * 1.2
    logo_resized = logo.resize((max(1, int(logo_w)), max(1, int(logo_h))), Image.Resampling.LANCZOS)
    img.alpha_composite(logo_resized, (int(center[0] - logo_w / 2), int(center[1] - logo_h / 2)))

    return img


def save_downsampled(img, target_px, path, force_rgb=False):
    out = img.resize((target_px, target_px), Image.Resampling.LANCZOS)
    if force_rgb:
        out = out.convert("RGB")
    out.save(path)
    print("wrote", path, out.size, out.mode)


if __name__ == "__main__":
    # icon.png — opaque background, the mark fills most of the frame.
    icon = build_mark(1024, outer_diam_frac=0.74, with_ambient_halo=True,
                       ring_stroke_frac=0.028, sat_frac=0.13, opaque_bg=True)
    save_downsampled(icon, 1024, f"{ASSETS}/icon.png", force_rgb=True)

    # adaptive-icon.png — transparent background, mark kept inside Android's ~66% safe zone so
    # no launcher mask (circle/squircle/rounded-square) clips the rings.
    adaptive = build_mark(1024, outer_diam_frac=0.58, with_ambient_halo=False,
                           ring_stroke_frac=0.03, sat_frac=0.14, opaque_bg=False)
    save_downsampled(adaptive, 1024, f"{ASSETS}/adaptive-icon.png")

    # splash-icon.png — transparent background, shown centred via resizeMode:'contain' over the
    # app's own dark backgroundColor; a modest central lockup rather than an edge-to-edge fill.
    splash = build_mark(1024, outer_diam_frac=0.62, with_ambient_halo=True,
                         ring_stroke_frac=0.028, sat_frac=0.13, opaque_bg=False)
    save_downsampled(splash, 1024, f"{ASSETS}/splash-icon.png")

    # favicon.png — tiny (96x96): fine ring/satellite detail would vanish, so this is a bolder,
    # simplified frame (thicker strokes, no ambient halo, bigger satellites) built the same way.
    favicon = build_mark(256, outer_diam_frac=0.86, with_ambient_halo=False,
                          ring_stroke_frac=0.05, sat_frac=0.20, opaque_bg=True)
    save_downsampled(favicon, 96, f"{ASSETS}/favicon.png", force_rgb=True)
