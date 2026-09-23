# ERD — entities and relationships

Source: documented domain model/data dictionary first, then schema/migrations for implemented tables, keys and constraints; ask if docs and schema differ or cardinality/optionality is unspecified. Pick logical ERD (domain concepts) or physical ERD (tables/columns) based on the request; don't silently mix them.

- Entity/table as a box/table; physical rows show column, type when useful, PK and FK. Relationship edge uses **crow's-foot** notation, not an architecture data-flow arrow. Place `0..1`, `1`, `0..*`, `1..*` on the correct ends; distinguish nullable FK from optional business participation. For M:N, show a junction table in a physical ERD.
- Label relationships only when their role is ambiguous (especially multiple FKs between the same two entities). Keep parent/child endpoints and direction consistent; for self-relations identify both roles.
- Audit: every drawn FK references an actual key or an explicitly documented planned relation; cardinality/optionality and uniqueness constraints are evidenced. Never infer one-to-one merely from singular entity names.

Draw.io `shape=table;childLayout=tableLayout` and `shape=tableRow` can provide editable rows; verify an ER-specific arrow style against the active editor or use explicit cardinality labels instead of inventing unsupported `endArrow` tokens.
