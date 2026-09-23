#!/usr/bin/env python3
"""Layout checker for .drawio diagrams: flag any edge label (badge) that sits on
top of a box or a frame title.

    python3 badge_overlap_audit.py                 # scan *.drawio under cwd (recursive)
    python3 badge_overlap_audit.py a.drawio b.drawio
    python3 badge_overlap_audit.py diagrams/       # a directory (recursive)

draw.io centres an edge label at the midpoint of its routed path; when that
midpoint (plus the label's own width) lands inside another node or over a
container's title strip, the badge is unreadable even though the arrow line is
clean. For every labelled edge this approximates the label anchor (length-
weighted midpoint of exit-point -> waypoints -> entry-point), builds the
label's bounding box (text-width heuristic), and flags an intersection with any
non-endpoint vertex -- a solid box, or the top title band of a ghost frame.

Heuristic, not a renderer: a flag is a strong hint to reroute the edge or drop
the label, not a proof. Exits 1 on any hit so it can gate a commit. See
references/readability.md for layout and review rules.
"""
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

TITLE_BAND = 26      # px height of a frame's title strip (top of the frame)
CHAR_W = 6.6         # px per label character (heuristic)
LABEL_PAD = 16       # px padding + border on a badge
LABEL_H = 22         # px badge height


def style_get(style, key):
    m = re.search(rf"(?:^|;){re.escape(key)}=([^;]*)", style or "")
    return m.group(1) if m else None


def strip_tags(v):
    return re.sub(r"&[a-zA-Z]+;", " ", re.sub(r"<[^>]+>", "", v or "")).strip()


def rects_intersect(a, b):
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    return not (ax + aw <= bx or bx + bw <= ax or ay + ah <= by or by + bh <= ay)


def rect_contains(outer, inner):
    """True if `outer` fully encloses `inner` — marks `outer` as a container."""
    ox, oy, ow, oh = outer
    ix, iy, iw, ih = inner
    return ox <= ix and oy <= iy and ox + ow >= ix + iw and oy + oh >= iy + ih


def analyze(path):
    findings = []
    for diagram in ET.parse(path).getroot().iter("diagram"):
        verts, edges = {}, []
        for c in diagram.iter("mxCell"):
            geo = c.find("mxGeometry")
            if c.get("vertex") == "1" and geo is not None:
                verts[c.get("id")] = (
                    float(geo.get("x", 0)), float(geo.get("y", 0)),
                    float(geo.get("width", 0)), float(geo.get("height", 0)),
                    c.get("style") or "", c.get("value") or "",
                )
            if c.get("edge") == "1":
                pts = [(float(p.get("x", 0)), float(p.get("y", 0)))
                       for arr in c.findall(".//Array") for p in arr.findall("mxPoint")]
                edges.append((c.get("id"), c.get("source"), c.get("target"),
                              c.get("style") or "", c.get("value") or "", pts))

        # A solid box that fully encloses another vertex is a container/background
        # (the central repo box, a group), not an obstacle — its children are the
        # real obstacles and are checked individually. Skip it to avoid false hits.
        boxes = {vid: v[:4] for vid, v in verts.items()}
        container_ids = {
            vid for vid, r in boxes.items()
            if any(wid != vid and rect_contains(r, r2) for wid, r2 in boxes.items())
        }

        def anchor(vid, ex, ey, style):
            if vid not in verts:
                return None
            x, y, w, h, _, _ = verts[vid]
            fx, fy = style_get(style, ex), style_get(style, ey)
            if fx is not None and fy is not None:
                return (x + float(fx) * w, y + float(fy) * h)
            return (x + w / 2, y + h / 2)

        for eid, src, tgt, style, value, pts in edges:
            label = strip_tags(value)
            if not label:
                continue
            p0 = anchor(src, "exitX", "exitY", style)
            p1 = anchor(tgt, "entryX", "entryY", style)
            if p0 is None or p1 is None:
                continue
            poly = [p0] + pts + [p1]
            segs = [((poly[i + 1][0] - poly[i][0]) ** 2 + (poly[i + 1][1] - poly[i][1]) ** 2) ** 0.5
                    for i in range(len(poly) - 1)]
            half, acc, lx, ly = sum(segs) / 2, 0, poly[0][0], poly[0][1]
            for i, l in enumerate(segs):
                if acc + l >= half and l > 0:
                    f = (half - acc) / l
                    lx = poly[i][0] + f * (poly[i + 1][0] - poly[i][0])
                    ly = poly[i][1] + f * (poly[i + 1][1] - poly[i][1])
                    break
                acc += l
            lw = len(label) * CHAR_W + LABEL_PAD
            lbox = (lx - lw / 2, ly - LABEL_H / 2, lw, LABEL_H)
            for vid, (x, y, w, h, vstyle, vval) in verts.items():
                if vid in (src, tgt):
                    continue
                if style_get(vstyle, "fillColor") == "none":
                    # ghost frame — flag only the title band, even though it's a container
                    if strip_tags(vval) and rects_intersect(lbox, (x, y, w, TITLE_BAND)):
                        findings.append((eid, label, round(lx), round(ly), "FRAME-TITLE", vid))
                elif vid in container_ids:
                    continue  # solid container background, not an obstacle
                elif style_get(vstyle, "fillColor") is not None and rects_intersect(lbox, (x, y, w, h)):
                    findings.append((eid, label, round(lx), round(ly), "BOX", vid))
    return findings


def collect(args):
    if not args:
        return sorted(Path.cwd().rglob("*.drawio"))
    files = []
    for a in args:
        p = Path(a)
        if p.is_dir():
            files.extend(sorted(p.rglob("*.drawio")))
        elif any(ch in a for ch in "*?["):
            files.extend(sorted(Path().glob(a)))
        else:
            files.append(p)
    return files


def main(argv):
    files = collect(argv)
    if not files:
        print("no .drawio files found")
        return 0
    total = 0
    for f in files:
        for eid, label, lx, ly, kind, vid in analyze(f):
            total += 1
            print(f"{f}: edge {eid} label '{label[:32]}' @({lx},{ly}) overlaps {kind} {vid}")
    if total:
        print(f"\n{total} badge/box overlap(s) across {len(files)} diagram(s) "
              f"-- reroute the label into a clear gap, lane it, or drop it.")
        return 1
    print(f"OK -- no badge/box overlaps across {len(files)} diagram(s).")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
