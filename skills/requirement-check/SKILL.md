---
name: requirement-check
description: Check the basis and feasibility of consequential user requirements before committing to a solution. Use for most medium/high-impact requests, and for low-impact requests when context suggests missing domain knowledge, questionable standards, contradictory assumptions, or nonsensical requirements. Ask what standard or evidence the user relies on; if they do not know, investigate and explain before asking them to decide. Distinct from ask-user, which clarifies intended outcomes.
---

# Requirement Check — establish a basis before acting

Use alongside `ask-user` when both the user's intended outcome and the basis for a requirement are uncertain. This skill is about **whether a proposed requirement makes sense in context**, not permission to override a user's informed choice.

1. For most medium/high-impact requests, check consequential requirements against known context before designing or changing anything. For low-impact requests, use judgment: ask only when a missing premise could plausibly make the result wrong. Impact includes cost, reversibility, security, correctness, downstream users, and operational consequences; do not turn routine, well-grounded tasks into a questionnaire.
2. Identify the specific missing premise, suspected misconception, conflicting constraints, or apparent impossibility. Ask a focused, neutral question: “Bạn dựa trên chuẩn/tiêu chí nào để yêu cầu X?” Include why it matters and what decision depends on it. Do not call a requirement nonsense without explaining the conflict. If the basis is already explicit and well-supported, do not ask redundantly.
3. If the user says they do not know or asks you to find out, investigate with available sources (project docs/code, applicable authoritative standards, official documentation). Distinguish mandatory constraints from conventions and your own recommendation; cite or identify sources when possible. Do not fabricate a universal standard. If sources are unavailable, inconclusive, or contradictory, disclose that and ask the user which tradeoff/authority to adopt rather than silently choosing.
4. Explain the relevant standard or evidence in plain language, why the original requirement may fail, and practical alternatives with consequences. Ask only the smallest question needed for the user to choose. **Wait for their answer** before work that depends on that choice; repeat the question/research cycle if the answer reveals another consequential unknown.
5. If the user understands the basis and intentionally chooses a nonstandard or risky approach, follow that choice and clearly warn about concrete foreseeable risks. Do not keep challenging the same settled decision. This does not bypass safety, legal, host-tool, or other higher-priority constraints; nor does a user preference turn an unsupported factual claim into a fact.

`ask-user` resolves **what the user wants**; this skill checks **what the request assumes**. Neither is an authorization gate or a reason to outsource researchable facts to the user.
