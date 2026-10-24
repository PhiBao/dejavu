#!/usr/bin/env python3
"""Generate Dejavu's README diagrams as editorial SVGs.

Usage: python3 docs/diagrams/generate.py


Follows the diagram-design skill's type specs:
- architecture: orthogonal connectors, <=9 nodes, 1-2 focal nodes, zones
- loop: parametric 5-station ring + one hub, dashed write-back spokes

Palette is Dejavu's own (ink/paper/accent), not the skill's default skin.
"""
import math
from pathlib import Path

OUT = Path(__file__).parent
OUT.mkdir(parents=True, exist_ok=True)

PAPER = "#f7f7f5"
INK = "#0f1115"
MUTED = "#5b5f66"
SOFT = "#8b8f96"
RULE = "#d9d7d0"
ACCENT = "#e4572e"
ACCENT_TINT = "#fdf0ec"
LINK = "#3b5b8c"
WHITE = "#ffffff"

SANS = "'Geist', 'Inter', system-ui, sans-serif"
MONO = "'Geist Mono', 'SFMono-Regular', ui-monospace, monospace"
SERIF = "'Instrument Serif', Georgia, serif"

MARKERS = f"""  <defs>
    <marker id="arrow" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
      <polygon points="0 0, 8 3, 0 6" fill="{MUTED}"/>
    </marker>
    <marker id="arrow-accent" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
      <polygon points="0 0, 8 3, 0 6" fill="{ACCENT}"/>
    </marker>
    <marker id="arrow-soft" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
      <polygon points="0 0, 8 3, 0 6" fill="{SOFT}"/>
    </marker>
  </defs>"""


def esc(s):
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def node(x, y, w, h, name, sub, tag, kind="backend"):
    """Node box: paper mask, styled box, rectangular type tag, name, sublabel."""
    fills = {
        "backend": (WHITE, INK),
        "store": ("#f0efec", MUTED),
        "external": ("#f4f3f0", "rgba(15,17,21,0.30)"),
        "input": ("#ececea", SOFT),
        "focal": (ACCENT_TINT, ACCENT),
    }
    fill, stroke = fills[kind]
    cx, cy = x + w / 2, y + h / 2
    tag_w = max(24, len(tag) * 5 + 10)
    out = [
        f'  <rect x="{x}" y="{y}" width="{w}" height="{h}" rx="6" fill="{PAPER}"/>',
        f'  <rect x="{x}" y="{y}" width="{w}" height="{h}" rx="6" fill="{fill}" stroke="{stroke}" stroke-width="1"/>',
        f'  <rect x="{x+8}" y="{y+6}" width="{tag_w}" height="12" rx="2" fill="none" stroke="{stroke}" stroke-opacity="0.4" stroke-width="0.8"/>',
        f'  <text x="{x+8+tag_w/2}" y="{y+15}" fill="{stroke}" fill-opacity="0.8" font-size="7" font-family="{MONO}" text-anchor="middle" letter-spacing="0.08em">{esc(tag)}</text>',
        f'  <text x="{cx}" y="{cy+1}" fill="{INK}" font-size="12" font-weight="600" font-family="{SANS}" text-anchor="middle">{esc(name)}</text>',
        f'  <text x="{cx}" y="{cy+16}" fill="{MUTED}" font-size="9" font-family="{MONO}" text-anchor="middle">{esc(sub)}</text>',
    ]
    return "\n".join(out)


def zone(x, y, w, h, label):
    lw = max(40, len(label) * 6 + 16)
    lx = x + 12
    return "\n".join([
        f'  <rect x="{x}" y="{y}" width="{w}" height="{h}" rx="8" fill="rgba(15,17,21,0.02)" stroke="rgba(15,17,21,0.10)" stroke-width="0.8"/>',
        f'  <rect x="{lx}" y="{y+4}" width="{lw}" height="12" rx="2" fill="{PAPER}"/>',
        f'  <text x="{lx+lw/2}" y="{y+13}" fill="{SOFT}" font-size="7" font-family="{MONO}" text-anchor="middle" letter-spacing="0.14em">{esc(label)}</text>',
    ])


def arrow(path, label=None, dashed=False, marker="arrow", color=MUTED, above=None, side=None):
    """above=(x, line_y): label above a horizontal segment, 8px gap.
    side=(line_x, y, 'right'|'left'): label beside a vertical segment, 8px gap."""
    dash = ' stroke-dasharray="5,4"' if dashed else ""
    out = [
        f'  <path d="{path}" fill="none" stroke="{color}" stroke-width="1.2"{dash} marker-end="url(#{marker})"/>'
    ]
    lw = max(36, len(label) * 5 + 16) if label else 0
    if label and above:
        lx, ly = above
        out.append(f'  <rect x="{lx-lw/2}" y="{ly-20}" width="{lw}" height="12" rx="2" fill="{PAPER}"/>')
        out.append(f'  <text x="{lx}" y="{ly-11}" fill="{SOFT}" font-size="7" font-family="{MONO}" text-anchor="middle" letter-spacing="0.08em">{esc(label)}</text>')
    if label and side:
        sx, sy, direction = side
        mx = sx + 8 if direction == "right" else sx - 8 - lw
        out.append(f'  <rect x="{mx}" y="{sy-6}" width="{lw}" height="12" rx="2" fill="{PAPER}"/>')
        out.append(f'  <text x="{mx+lw/2}" y="{sy+3}" fill="{SOFT}" font-size="7" font-family="{MONO}" text-anchor="middle" letter-spacing="0.08em">{esc(label)}</text>')
    return "\n".join(out)


# ---------------------------------------------------------------- architecture
def architecture():
    W, H = 960, 520
    p = []
    p.append(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" role="img" aria-labelledby="arch-title arch-desc">')
    p.append('  <title id="arch-title">Dejavu system architecture</title>')
    p.append('  <desc id="arch-desc">The Dejavu app captures and recalls memories through Walrus Memory, with judgments from Jev and an independent onchain check through Tatum Sui gRPC.</desc>')
    p.append(MARKERS)
    p.append(f'  <rect width="100%" height="100%" fill="{PAPER}"/>')
    p.append(f'  <text x="32" y="24" fill="{SOFT}" font-size="7" font-family="{MONO}" letter-spacing="0.18em">MEMORY COMPANION · WALRUS × TATUM</text>')
    p.append(f'  <text x="32" y="50" fill="{INK}" font-size="24" font-family="{SERIF}">Dejavu — system overview</text>')

    # zones
    p.append(zone(32, 72, 216, 264, "CLIENT"))
    p.append(zone(268, 72, 284, 368, "APP"))
    p.append(zone(648, 72, 284, 376, "EXTERNAL SERVICES"))

    # arrows first (z-order)
    p.append(arrow("M 220,144 H 300", "CAPTURE · ASK", above=(260, 144)))
    p.append(arrow("M 220,272 H 300", "MCP", above=(260, 272)))
    p.append(arrow("M 410,252 V 352", "STORE", side=(410, 316, "right")))
    p.append(arrow("M 520,132 H 680", "WRITE", above=(600, 132)))
    p.append(arrow("M 680,156 H 520", "READ", dashed=True, marker="arrow-soft", above=(600, 156)))
    p.append(arrow("M 520,196 H 620 V 264 H 680", "VERIFY", side=(620, 230, "right")))
    p.append(arrow("M 520,232 H 600 V 384 H 680", "PROSE", side=(600, 344, "right")))
    p.append(arrow("M 790,224 V 184", "CHECK", dashed=True, marker="arrow-soft", color=SOFT, side=(790, 204, "right")))

    # nodes
    p.append(node(60, 112, 160, 64, "Capture & recall", "next.js · server actions", "WEB", "input"))
    p.append(node(60, 240, 160, 64, "External agent", "claude code · cursor", "MCP", "external"))
    p.append(node(300, 112, 220, 140, "Memory pipeline", "extract · decide · rank · verify", "CORE"))
    p.append(node(300, 352, 220, 64, "Projection", "people · facts · due dates", "STORE", "store"))
    p.append(node(680, 104, 220, 80, "Walrus Memory", "encrypted blobs · mainnet", "BLOB", "focal"))
    p.append(node(680, 224, 220, 80, "Tatum Sui gRPC", "epoch · delegation · blobs", "RPC", "focal"))
    p.append(node(680, 344, 220, 80, "Prose writer", "qwen · token factory", "LLM", "external"))

    # legend
    p.append(f'  <line x1="32" y1="466" x2="928" y2="466" stroke="rgba(15,17,21,0.10)" stroke-width="0.8"/>')
    p.append(f'  <text x="32" y="486" fill="{MUTED}" font-size="8" font-family="{MONO}" letter-spacing="0.14em">LEGEND</text>')
    items = [("SOLID — REQUEST", MUTED, False), ("DASHED — RETURN / VERIFY", SOFT, True), ("ACCENT — SPONSOR INFRA", ACCENT, False)]
    x = 130
    for text, color, dashed in items:
        dash = ' stroke-dasharray="5,4"' if dashed else ""
        p.append(f'  <line x1="{x}" y1="483" x2="{x+22}" y2="483" stroke="{color}" stroke-width="1.4"{dash}/>')
        p.append(f'  <text x="{x+28}" y="486" fill="{MUTED}" font-size="8" font-family="{MONO}">{text}</text>')
        x += 40 + len(text) * 5.2 + 40
    p.append("</svg>")
    (OUT / "architecture.svg").write_text("\n".join(p) + "\n")


# ------------------------------------------------------------------------ loop
def circle_rect_intersections(cx, cy, r, x, y, w, h):
    """Intersections of a circle with an axis-aligned rect, as angles (deg)."""
    pts = []
    edges = [
        ("v", x, y, y + h), ("v", x + w, y, y + h),
        ("h", y, x, x + w), ("h", y + h, x, x + w),
    ]
    for kind, fixed, lo, hi in edges:
        if kind == "v":
            d = r * r - (fixed - cx) ** 2
            if d < 0:
                continue
            root = math.sqrt(d)
            for yy in (cy - root, cy + root):
                if lo - 0.001 <= yy <= hi + 0.001:
                    pts.append((fixed, yy))
        else:
            d = r * r - (fixed - cy) ** 2
            if d < 0:
                continue
            root = math.sqrt(d)
            for xx in (cx - root, cx + root):
                if lo - 0.001 <= xx <= hi + 0.001:
                    pts.append((xx, fixed))
    angles = sorted({round(math.degrees(math.atan2(py - cy, px - cx)) % 360, 3) for px, py in pts})
    return angles


def loop():
    W, H = 1040, 720
    cx, cy, R = 520, 380, 240
    sw, sh = 160, 64
    hw, hh = 200, 104
    n = 5
    stations = [
        ("Capture", "one sentence", False),
        ("Recall", "cited answer", False),
        ("Record hit", "memory earned it", False),
        ("Score", "explainable importance", True),
        ("Renew", "before expiry", False),
    ]
    centers = []
    for k in range(n):
        theta = math.radians(-90 + k * 360 / n)
        centers.append((cx + R * math.cos(theta), cy + R * math.sin(theta)))

    boxes = []
    for (px, py) in centers:
        x = round((px - sw / 2) / 4) * 4
        y = round((py - sh / 2) / 4) * 4
        boxes.append((x, y))

    p = []
    p.append(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" role="img" aria-labelledby="loop-title loop-desc">')
    p.append('  <title id="loop-title">The Dejavu learning loop</title>')
    p.append('  <desc id="loop-desc">Every recall records which memory earned the answer; importance is scored from usage and drives ranking and renewal priority, with each pass written back to memory on Walrus.</desc>')
    p.append(MARKERS)
    p.append(f'  <rect width="100%" height="100%" fill="{PAPER}"/>')
    p.append(f'  <text x="64" y="40" fill="{SOFT}" font-size="7" font-family="{MONO}" letter-spacing="0.18em">LEARNING LOOP · MEMORIES THAT CHANGE THE PRODUCT</text>')
    p.append(f'  <text x="64" y="66" fill="{INK}" font-size="24" font-family="{SERIF}">What Dejavu learns from being used</text>')

    # ring arrows: clockwise arcs between adjacent stations
    for k in range(n):
        a = circle_rect_intersections(cx, cy, R, *boxes[k], sw, sh)
        b = circle_rect_intersections(cx, cy, R, *boxes[(k + 1) % n], sw, sh)
        theta_k = (-90 + k * 360 / n) % 360
        theta_j = (-90 + (k + 1) * 360 / n) % 360
        # exit: first intersection clockwise after theta_k
        def after(angles, t):
            cands = [x for x in angles if x > t + 0.5]
            return min(cands) if cands else min(angles)
        def before(angles, t):
            cands = [x for x in angles if x < t - 0.5]
            return max(cands) if cands else max(angles)
        exit_a = after(a, theta_k)
        entry_b = before(b, theta_j)
        overhang = math.degrees(1.2 / R)
        end = entry_b - overhang
        sx = cx + R * math.cos(math.radians(exit_a))
        sy = cy + R * math.sin(math.radians(exit_a))
        ex = cx + R * math.cos(math.radians(end))
        ey = cy + R * math.sin(math.radians(end))
        large = 1 if ((entry_b - exit_a) % 360) > 180 else 0
        p.append(
            f'  <path d="M {sx:.3f},{sy:.3f} A {R},{R} 0 {large} 1 {ex:.3f},{ey:.3f}" '
            f'fill="none" stroke="{MUTED}" stroke-width="1.2" marker-end="url(#arrow)"/>'
        )

    # dashed write-back spokes: station inner edge -> just outside hub
    for k, (px, py) in enumerate(centers):
        theta = math.radians(-90 + k * 360 / n)
        ux, uy = math.cos(theta), math.sin(theta)

        def box_dist(half_w, half_h):
            vals = []
            if abs(ux) > 1e-9:
                vals.append(half_w / abs(ux))
            if abs(uy) > 1e-9:
                vals.append(half_h / abs(uy))
            return min(vals)

        d_st = box_dist(sw / 2, sh / 2)
        d_hub = box_dist(hw / 2, hh / 2)
        start = (px - d_st * ux, py - d_st * uy)
        end = (cx + (d_hub + 6) * ux, cy + (d_hub + 6) * uy)
        p.append(
            f'  <path d="M {start[0]:.3f},{start[1]:.3f} L {end[0]:.3f},{end[1]:.3f}" '
            f'fill="none" stroke="{SOFT}" stroke-width="1" stroke-dasharray="5,4" marker-end="url(#arrow-soft)"/>'
        )

    # station boxes
    for k, ((name, sub, focal), (x, y)) in enumerate(zip(stations, boxes)):
        p.append(node(x, y, sw, sh, name, sub, f"{k+1:02d}", "focal" if focal else "backend"))

    # hub
    hx, hy = cx - hw / 2, cy - hh / 2
    p.append(f'  <rect x="{hx}" y="{hy}" width="{hw}" height="{hh}" rx="8" fill="{INK}"/>')
    p.append(f'  <text x="{cx}" y="{cy-4}" fill="{PAPER}" font-size="14" font-weight="600" font-family="{SANS}" text-anchor="middle">Memory</text>')
    p.append(f'  <text x="{cx}" y="{cy+14}" fill="{PAPER}" fill-opacity="0.62" font-size="9" font-family="{MONO}" text-anchor="middle">on Walrus · one record</text>')

    # legend
    p.append(f'  <line x1="64" y1="664" x2="976" y2="664" stroke="rgba(15,17,21,0.10)" stroke-width="0.8"/>')
    p.append(f'  <text x="64" y="684" fill="{MUTED}" font-size="8" font-family="{MONO}" letter-spacing="0.14em">LEGEND</text>')
    p.append(f'  <line x1="160" y1="681" x2="182" y2="681" stroke="{MUTED}" stroke-width="1.4"/>')
    p.append(f'  <text x="188" y="684" fill="{MUTED}" font-size="8" font-family="{MONO}">LOOP</text>')
    p.append(f'  <line x1="260" y1="681" x2="282" y2="681" stroke="{SOFT}" stroke-width="1.4" stroke-dasharray="5,4"/>')
    p.append(f'  <text x="288" y="684" fill="{MUTED}" font-size="8" font-family="{MONO}">WRITE-BACK TO MEMORY</text>')
    p.append(f'  <text x="640" y="684" fill="{SOFT}" font-size="8" font-family="{MONO}">ACCENT = THE SCORING GATE</text>')
    p.append("</svg>")
    (OUT / "loop.svg").write_text("\n".join(p) + "\n")


architecture()
loop()
print("wrote", OUT / "architecture.svg")
print("wrote", OUT / "loop.svg")
