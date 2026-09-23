# Functional decomposition — capability tree

This is a **hierarchy of product capabilities**, not a use-case actor map and not an authorization matrix. Source: requirements, product feature inventory, navigation/function spec; ask which product scope/version to model when ambiguous.

- Root = product/domain; next levels = capability groups → user-visible functions/subfunctions. Name each node with a capability/action, use one parent per node in the tree; cross-cutting functions belong in a separate shared capability or a labeled dependency, not duplicated as if owned by several parents.
- Parent-child connector means **contains/decomposes**, not calls, data flow, workflow order or permission. Use neutral solid hierarchy lines without flow arrowheads; if a link means dependency, label and style it differently or move it to a separate view.
- Show stable numbering (e.g. 1, 1.1) only if the source specifies or it aids traceability. If rights are needed, use a separate role×function permission matrix or link to a use-case model backed by documented policy.
- Audit: siblings are at similar abstraction level, no unsubstantiated feature, no duplicate branches, leaf functions trace to documented functionality.
