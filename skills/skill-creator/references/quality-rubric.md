# Skill Quality Rubric — S→F (v1, 2026-07-10)

Reference frame for grading every skill in this repo. Grounded in published
standards, not invented:

| Source | What we take from it |
|---|---|
| [Anthropic — Skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices) | description = WHAT+WHEN in 3rd person; concise ("context window is a public good", assume the model is smart); <500-line body; refs 1 level deep; degrees of freedom matched to task fragility; workflows + checklists; feedback loops (validator → fix → repeat); plan-validate-execute; scripts "solve, don't punt"; no voodoo constants; no time-sensitive info; **evaluation-driven development (≥3 evals, built FIRST)**; cross-model testing |
| [Anthropic — Equipping agents for the real world](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills) | skills = distilled procedural knowledge; iterate from observed agent behavior, not assumptions |
| [OpenAI — Function calling guide](https://developers.openai.com/api/docs/guides/function-calling) | the "intern test" (usable with zero outside context); description states when to invoke AND how; offload work from model to code; description tokens are a per-call cost |
| [ISO/IEC 25010:2023](https://www.iso.org/standard/78176.html) | top-level split: functional suitability, reliability, usability(-for-the-agent), maintainability, portability |

## Six dimensions, 0–3 points each (sum /18)

| # | Dimension | 3 points looks like | 0 points looks like |
|---|---|---|---|
| D1 | **Discovery** — description & triggers | 3rd person; WHAT + WHEN; concrete trigger phrases incl. Vietnamese aliases; distinguishable from sibling skills | vague ("helps with X"); overlaps siblings; wrong person |
| D2 | **Actionability & degrees of freedom** | imperative; runnable commands; freedom level matches fragility (exact script for fragile ops, heuristics for open ones); ❌/✅ examples; consistent terminology | prose advice; multiple unranked options; "consider doing X" |
| D3 | **Token economy & progressive disclosure** | lean body (≤~150 lines unless justified); depth in references/ 1 level deep; nothing the model already knows; scripts executed not pasted | body restates common knowledge; duplicated frontmatter; >500 lines |
| D4 | **Reliability & verification** | machine gate (validator script, exit code) or explicit feedback loop; done-criteria; boundaries + off-switch for modes; plan-validate-execute for batch/destructive ops | no way to tell success from failure; silent failure paths |
| D5 | **Portability & maintainability** | coordinator-agnostic; no hardcoded machine paths; per-host setup in references; deps declared; no time-sensitive facts (or dated "environment notes") | assumes one host; absolute paths; facts that rot silently |
| D6 | **Evidence & evals** | ≥3 evaluation scenarios, or measured claims (benchmarks), or rules distilled from documented real failures ("why the rules exist") | invented-from-imagination instructions; unmeasured savings claims |

Scoring: 3 = exemplary · 2 = solid, minor gaps · 1 = present but weak · 0 = absent/wrong.

## Tier gates

| Tier | Gate |
|---|---|
| **S** | sum ≥ 17 AND every D ≥ 2 AND (D4 = 3 or D6 = 3). Reference standard — usable as a template for new skills. |
| **A** | sum 13–16, every D ≥ 1. Strong; scheduled polish only. |
| **B** | sum 10–12, or any single systemic gap (no verification path, drift-prone duplication). Usable; upgrade planned. |
| **C** | sum 7–9. Works but adds little over a good prompt; rewrite candidate. |
| **D** | sum 4–6, or any actively misleading/stale content. Fix before next use. |
| **F** | sum < 4, fails validators, technically wrong, or harmful. Remove or rebuild. |

Judgment may move a skill ±1 tier from its sum; when it does, the grader MUST
record why in the grading note.

## How to run a grading pass

1. Both repo validators must PASS first (an F otherwise).
2. Score the six dimensions from the skill's actual files — read SKILL.md fully,
   spot-check scripts/references; run any bundled checker.
3. Record: `skill · six scores · sum · tier · one-line note` in the grading
   report (dated file or PR description). Grades are point-in-time snapshots;
   this rubric file stays timeless.
4. Repo-wide gaps (a dimension scoring ≤2 across most skills) become the
   upgrade plan's priorities — fix the system, not just the skill.
