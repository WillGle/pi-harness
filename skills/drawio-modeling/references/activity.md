# UML activity — workflow and decisions

Source: process/UX/acceptance criteria with ordered actions, responsible parties, conditions, exception and termination paths. Ask for missing branch conditions or parallelism; do not turn an unordered feature list into a workflow.

- Start = solid initial node; action = rounded rectangle; decision/merge = diamond with **guards** such as `[approved]` / `[rejected]` on outgoing decision edges. Draw arrows in execution order; distinguish activity-final (whole workflow ends) from flow-final (one branch ends).
- Use fork/join bars only for documented parallel paths; do not treat an ordinary split as concurrent. Swimlanes optionally assign actions to roles/systems; each action belongs to the actor responsible, while cross-lane edges represent handoffs. Show loops and exception paths when the documented flow requires them.
- Audit: every decision path has a guard (including else/default where applicable); all started paths have an appropriate conclusion or a documented loop, and joins cannot imply a wait for mutually exclusive branches.

Use verified draw.io UML activity shapes if available; otherwise draw equivalent editable standard symbols and keep guard/flow semantics intact.
