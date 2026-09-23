# Architecture readability contract

Distilled from `skills-central/architecture-diagram` and the editable architecture figures in CPDA; this is a layout/communication system, **not** a mandate to use CPDA's scientific palette or publication pipeline in another repo.

## Plan the picture

- Draw only evidenced components and relations that serve the question. Assign each component a role; choose left→right for a pipeline or top→bottom for a dependency stack. Group by tier/responsibility with quiet containers or dashed frames; keep hubs central. Use separate pages or a collapsed view when the graph is too dense.
- Leave ≥15px padding around group contents, ~20px between boxes, and a clear ~60px routing lane for long arrows. Increase canvas size instead of shrinking text. For a narrative view (why/how/impact), use columns or tiers; put constraints near the top and a takeaway/legend at the bottom *only if helpful and allowed by repo rules*.
- Give nodes short names and a second line for role/technology when useful. Title describes viewpoint; dates and in-image titles are optional and yield to repo publication rules. Aim for readable ~11px body, ~10px annotations, ~15px title at normal export size; never shrink below readable size to fit.

## Theme and meaning

- First preserve repo palettes, entity-role colors and explicit branding; otherwise choose a small, contrast-safe set (e.g. pale blue for core, pale green for data/validation, pale orange for key output, gray for external/neutral). Match text contrast to actual fill and canvas: white on dark nodes, dark on light ones. No reliance on color alone: direct labels, dashed/solid patterns and a legend for 3+ semantic colors.
- For ordinary architecture (not UML/ERD/BPMN), solid arrows = primary data/artifact flow; dashed = secondary, fallback, tooling or control. Label any dashed, feedback, long or ambiguous edge with a short action or payload; obvious adjacent sequential arrows need no labels. Do not misrepresent a non-directional dependency as data movement. Semantic notation of a specialized diagram always wins.
- Use orthogonal routing for normal app architecture connections; pin endpoints and spread ports on busy nodes. Reserve outer lanes and waypoints for feedback, avoid passing lines through unrelated shapes or frame headers. Crossings may use `jumpStyle=arc;jumpSize=6` but line jumps do not repair poor geometry. For dense multi-path diagrams, matching a source-role stroke can aid tracing; do not use a color inconsistent with the repo's code.
- On a light background, put labeled edges on a contrasting background (`labelBackgroundColor=#ffffff`); a small bordered HTML badge is helpful if supported by the renderer. Adapt background/font to dark themes. A badge wider than the gap still collides: widen the gap, move the route/label to empty space, or remove a redundant label. No edge should connect to a legend, reading guide, or footnote.

## Review

- XML must parse, root IDs `0`/`1` must exist, all edges need relative `mxGeometry`, and labels must escape XML metacharacters. For hand-authored uncompressed files run the bundled badge audit; it estimates label anchors, not actual auto-routed paths, and does not fully model nested parent coordinates.
- Inspect a render (PNG/PDF/SVG) at intended size: no clipped labels, hidden arrowheads, stacked ports, badge-on-box/frame/title, or edge through unrelated content. If the renderer is unavailable, say so; a passing XML/audit check is not visual proof. Existing files keep manual positions and IDs unless explicitly relaid out.
