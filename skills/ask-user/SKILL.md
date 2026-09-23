---
name: ask-user
description: Clarify vague, broad or ambiguous user requests before planning or acting. Use independently of /plan, or within /plan, whenever uncertainty about the user's needs, goals, scope, priorities or success criteria could change what to do. Ask focused questions and wait for answers instead of silently choosing defaults. Not an approval or permission tool.
---

# Ask User — clarify intent, not permission

Use this skill with or without `/plan`. It is a conversation workflow, not an interactive UI or an authorization gate; it never grants tool permissions. Other skills can invoke its rules whenever the requested outcome is unclear.

1. Separate **user-intent uncertainty** (what outcome, audience, scope, priority, format, source of truth or acceptance criteria they want) from **researchable facts** (what the repo/code/docs actually do). Investigate researchable facts with available read-only tools; do not ask the user to do agent research. If relevant evidence conflicts or does not settle an intent decision, ask.
2. Before proposing a definitive plan, choosing a design, or changing files, identify decisions where different reasonable interpretations produce materially different outcomes. Do **not** pick a default or present an unconfirmed assumption as the user's choice. Even a seemingly minor choice must be asked if it changes the intended deliverable. A direct user instruction or explicit delegation to choose resolves that choice; no redundant question is needed.
3. Ask the smallest useful batch of concrete, neutral questions. State the interpretation/options and the consequence of each when helpful. Prefer “Do you mean A (… ) or B (… )?” over “Please clarify.” Do not bury a recommended default in the wording. If an open answer is needed, ask openly; do not invent options as facts.
4. **Stop at the question.** Wait for the user's reply before proceeding with work that depends on it. Carry forward their decisions and ask again only if the reply creates a new material ambiguity. If several things are unclear, group the questions so the user can answer once. If part of the request is independent, only proceed with that part when doing so cannot commit to an unresolved direction.
5. In `/plan`, ask before finalizing numbered steps/verification criteria. Outside `/plan`, follow exactly the same clarification gate before implementation. The agent asks in the current chat; use a future AskUser UI/tool only if it actually exists and is available. Never claim that a question has been answered or that a capability exists when it has not.

**Not for:** routine permission confirmations (governed by host tool policy), asking questions already answered by the user, or replacing investigation of repo facts with guesses. An intent question is answered by the user; a factual claim still needs evidence.
