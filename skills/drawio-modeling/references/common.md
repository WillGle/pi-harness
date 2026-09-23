# Common evidence, authoring and review

## Evidence gate

Look for product specification, domain model, API contracts, permissions/policies, process descriptions, UX flows, database migrations and existing diagrams; record the relevant document section/file for each nontrivial fact. Order: repo governance and documented product requirements → user clarification for gaps/conflicts → implementation evidence for *actual implementation details*. A schema may document implemented columns but does not prove business meaning; route handlers may show enforcement but do not prove intended permissions. If no relevant documents exist, ask the user for the model or approval to use code as the source of truth **before drawing**. If a relevant document is silent about an indispensable edge/cardinality/guard/role, ask rather than filling it from intuition. If docs conflict with implementation, surface the discrepancy and ask which version to represent; do not silently reconcile them.

Use the `ask-user` skill for the fewest targeted questions that unblock the diagram. Ask in the current chat; do not claim there is an interactive AskUser tool unless one is actually available.

## Draw.io mechanics

Editable plain XML: `<mxfile><diagram><mxGraphModel><root>` with reserved `mxCell` IDs `0` and `1`; every vertex needs geometry, every edge needs `<mxGeometry relative="1" as="geometry"/>`. Escape XML attribute values (`&amp;`, `&lt;`, `&quot;`). Use `html=1` for formatted labels. Actual draw.io containers give children parent-relative coordinates; use correct parents or root-level layout consistently. Shape identifiers must be verified against the installed draw.io library/tool; if unavailable, use legible generic boxes/lines while keeping the formal edge semantics and label notation. Do not guess a vendor-specific shape name.

`python3 -c 'import sys,xml.etree.ElementTree as E; E.parse(sys.argv[1])' diagram.drawio` checks XML only. Then check unique IDs, valid endpoints, notation-specific invariants in the selected reference, and visually inspect the exported image. No inferred relation should be presented as confirmed. Keep the editable file even when providing an image.

When no renderer is installed, do the XML/semantic checks and say the render/visual check was not possible; do not claim a diagram looks good without seeing it.
