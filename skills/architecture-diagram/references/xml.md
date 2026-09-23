# Minimal editable draw.io XML

Use `assets/template.drawio` as a *starting example*, not as a fixed repo theme. Change title/labels/colors to match the host repo. Add cells under `<root>`; reserve `id="0"` and `id="1"`. For root-level cells use `parent="1"` and absolute geometry; if using actual draw.io containers, set children to `parent="<container-id>"` with coordinates relative to that container. Unique, stable semantic IDs make local edits reviewable.

Every edge needs `source`, `target`, `edge="1"` and `<mxGeometry relative="1" as="geometry"/>`; for routes, add `<Array as="points"><mxPoint x="..." y="..."/></Array>` inside geometry. For plain architecture edges use `edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=blockThin;endFill=1;` and add `exitX/exitY/entryX/entryY` to spread endpoints. The edge's `value` can be empty; nonempty labels must be XML-escaped (`&amp;`, `&lt;`, `&quot;`) and remain readable over the line. Shape labels can use escaped `<b>` and `<br>` when `html=1`. Never put `--` in XML comments.

Validate: `python3 -c 'import sys,xml.etree.ElementTree as ET; ET.parse(sys.argv[1])' diagram.drawio`. For imported/compressed draw.io files use the dedicated importer/editor rather than editing unreadable compressed content as text; the bundled label checker expects plain XML with explicit geometry.
