# UML state machine — lifecycle of one object

Source: lifecycle/business rules and event specifications; ask for missing transition triggers, guards, terminal semantics or contradictory state definitions. Do not use screens/routes or workflow steps as states unless they genuinely describe persistent object state.

- State = rounded box named for a stable condition; initial pseudostate = filled dot; final state = bullseye only if the object's lifecycle truly ends. Directed transitions have `event [guard] / effect` when known. Use an unlabeled completion transition only when the source explicitly describes completion behavior.
- Nested states or orthogonal regions only if needed to model a documented hierarchy/concurrency; don't force transitions between exclusive states to look parallel. Show self-loops for meaningful repeated events and explicitly documented terminal states.
- Audit: each transition has a real trigger/guard or is explicitly a completion transition; the same event+guard combination is not ambiguous without a documented priority; terminal states do not accidentally have outgoing transitions. Keep state-machine edges distinct from activity control flows.
