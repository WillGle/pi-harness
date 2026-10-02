# Manual

## Start and inspect work

Describe the objective, limits, and checks you need. Small tasks can be done directly; delegation is optional.

Use `/goal <objective>` to save an objective, `/status` to inspect progress, and `/goal status` to read the selected work summary.

The main agent can accept or reject task results. Rejected tasks may be retried, with at most two attempts per task. Completion requires every delegated task to be accepted.

## Read results

Each result shows which command ran, whether it passed, and whether another agent reviewed it.

- `verified`: the recorded checks passed. Read which checks ran.
- `not_verified`: the requested conditions have not been verified.
- `failed` or `blocked`: inspect the failure or blocker before continuing.
- `unknown`: execution was interrupted or its outcome cannot be confirmed.

Main-agent acceptance is recorded separately from verification. It does not mean another agent reviewed the result. A returned code branch is not automatically merged.

## Resume after interruption

```text
/work list
/work resume <id>
```

Saved work is not reopened automatically. Use an ID from the list.

For an `unknown` task, ask the main agent to resolve that task ID. It uses `pi_harness_work` with `action: "resolve"`. Resolution requires confirmation that the old execution has ended. It enables a retry if an attempt remains; it never creates a successful result.

If execution is still active or cannot be checked, the task stays unknown. `/work cancel` abandons selected work while keeping its records.

Old Mission/Operation records need the previous Harness to resolve or archive them. The current version does not convert or delete them.

## Skills, notes, and usage

`/skill-hub` lists skills to invoke explicitly. `/learn status` reads saved project notes; `/learn clear` removes them. Saved notes are included in future prompts sent to your model provider.

Context and cost figures describe recorded usage. Missing figures stay unknown. Pi manages model settings and shortens conversation history when needed.
