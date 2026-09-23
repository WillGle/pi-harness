---
name: drawio-modeling
description: Create or edit editable draw.io diagrams for ERD, functional decomposition, UML activity, sequence, state machine and use-case models. Use when a user requests one of these diagram types from product documents, schemas or source code. Prefer formal notation over decorative architecture styles; use architecture-diagram instead for app/system component architecture.
---

# Draw.io product models

Create editable `.drawio` models, not architecture posters. Route to **one** reference: [ERD](references/erd.md), [functional decomposition](references/functional.md), [activity](references/activity.md), [sequence](references/sequence.md), [state machine](references/state-machine.md), or [use-case](references/use-case.md). For source-of-truth and review rules read [common workflow](references/common.md). For an app/product component map instead use `architecture-diagram`; never mix its arrow/color grammar with a formal notation.

1. Establish question, scope, diagram type, system boundary and source documents. **Documents are authoritative**; source/schema/code can corroborate or supply implementation detail, but must not silently override a documented requirement. If no relevant document exists, or a material requirement is missing/contradicted, **ask the user before inventing model facts**. Follow the `ask-user` skill's clarification workflow (ask in the current chat); do not require any special UI tool.
2. Extract a small, traceable model (entities/roles/events/interactions as relevant); mark explicit vs inferred. Confirm unresolved cardinalities, rights, ordering, guards and state transitions before drawing. Do not conflate actor participation with authorization.
3. Apply the selected reference's **standard notation first**. Repo figure/publication policy and color/contrast preferences may style the model, but cannot change the meaning of crow's feet, UML arrows, guards or fragments. Hand-author XML from [neutral starter](assets/template.drawio) or use a suitable installed draw.io importer; do not assume a specialized toolbox exists. Preserve stable IDs/layout for local edits; no secrets in labels/provenance.
4. Parse XML, check connections and semantics against evidence, then render and inspect at reading size (labels, direction, line crossings, clipping). If renderer unavailable, report the visual check as unverified. Deliver `.drawio`; export PNG/PDF/SVG when requested or helpful for review.
