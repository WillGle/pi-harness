# UML sequence — one scenario over time

Source: documented scenario/API contract first, then code for actual call sites/async behavior. Ask for uncertain participant order, error path or sync/async behavior; do not infer causality from imports alone.

- Participants across the top, lifelines downward; time progresses **top to bottom**. Messages connect source to destination and carry operation/event names (and payload/response only if useful). Sync calls use filled call arrows; async signals use open arrowheads; returns use dashed lines, usually with open arrowheads. Activation bars represent time in control, not process ownership.
- Show alternate/error paths with labeled `alt`/`else` fragments and guards, repetition with `loop`, optional behavior with `opt`, concurrency with `par` only when evidenced. A response should return to its actual caller; do not invent a direct participant-to-participant call to shorten the picture.
- Audit: chronological order, message source/target, sync-vs-async and return destination match the scenario; frame guards and error paths are documented. Split distinct scenarios into pages rather than interleave them.

If an installed `seqlayout`/draw.io generator supports lifelines use it; otherwise manually retain consistent spacing and proper UML line styles in editable XML.
