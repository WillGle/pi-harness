---
name: architecture-diagram
description: Create or edit readable, editable draw.io architecture diagrams of a repository, app, product or system. Use for project structure, components, dependencies, data flow and deployment, including requests like "vẽ sơ đồ kiến trúc" or "diagram this codebase". Do not use for ERD/UML/BPMN with formal notation or for charts.
---

# Project architecture diagrams

Deliver an editable `.drawio` that answers one architecture question. This skill is the small, shared architecture workflow; use a dedicated draw.io skill/toolbox for specialized importers, exports or formal diagram types when available. Python 3 stdlib suffices for XML checks; draw.io CLI is optional for rendering.

## Workflow

1. Read the repo's diagram/branding/figure rules and existing diagrams *first*. Repo publication and provenance rules win; within them follow the user's request, then this skill's defaults. An explicit restyle may change colors; do not silently restyle an existing diagram. If draw.io files are only reference sketches, do not overwrite canonical generated figures.
2. Identify the question, audience and viewpoint (code structure, declared infrastructure, or **observed runtime**). If the intended outcome is vague, follow `ask-user` and wait for clarification rather than assuming a default view. Inspect only relevant source/config/evidence; inventory components, roles, source→target relationships and confidence. Do not infer live runtime from static config; do not invent links, metrics or secrets. Omit nodes that do not answer the question. Mark uncertain/inferred connections explicitly or ask if consequential.
3. Pick one reading direction; group by responsibility/tier; reserve space for edge labels and feedback corridors. Collapse complexity into a higher-level view or separate pages if needed; use an existing importer/autolayout for large graphs rather than forcing a dense one-page layout. Follow [readability rules](references/readability.md) for layout, semantic encoding and theme-first styling. For hand-authored XML start from [template](assets/template.drawio), then follow [XML notes](references/xml.md).
4. Generate/update `.drawio` with stable IDs. When editing, preserve positions, manual styling and provenance unless the request requires a broader change. Keep HTML/XML escaped and do not include credentials in labels or properties.
5. Parse XML; run `python3 <skill-dir>/assets/badge_overlap_audit.py path/to/file.drawio` for hand-authored plain XML; its flags are hints, not renderer truth. Render and inspect at intended reading size when a renderer is available; check label/box collisions, crossings through unrelated nodes and legibility. Fix defects before delivery. If rendering is unavailable, report that visual verification remains unverified. Export PNG/SVG/PDF only when requested or useful for review; never substitute a flattened image for the editable source.

**Priority:** readability and faithful relationships > decorative density. Reuse project colors; do not impose white canvas/black text, a date, or a word limit on another project. The diagram's labels and line patterns must still make sense without color.
