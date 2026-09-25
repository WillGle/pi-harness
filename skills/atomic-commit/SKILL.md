---
name: atomic-commit
description: >
  Splits working-tree changes into atomic commits: one logical change per
  commit, each buildable, revertable, and reviewable on its own. Plans the
  partition from the full diff, stages per unit (including hunk-level staging
  without interactive mode), orders commits by dependency, and verifies each
  one. Use when the user says "atomic commit", "commit nguyên tử", "split
  this into commits", "tách commit", "commit theo từng phần", or when a large
  mixed diff is about to be committed as one blob.
---

Turn the current working-tree changes into a sequence of atomic commits.
Atomic = ONE logical change: it builds and passes tests alone, `git revert`
of it undoes exactly one decision, and a reviewer can hold all of it in
their head. Atomic ≠ tiny — a 40-file rename can be one commit; a 3-line
diff mixing a bugfix with a rename must be two.

This skill decides WHAT goes in each commit and stages it. Message wording
follows the repo's convention (Conventional Commits by default); if a
commit-message skill such as caveman-commit is installed, use it for the
text.

## Never mix in one commit

- Behavior change + refactor (the diff hides the semantic change).
- Feature + unrelated drive-by fix ("while I was there…" → own commit).
- Code + unrelated formatting/whitespace churn.
- Two independent features, even if small.
- Generated files (lockfiles, snapshots, built assets) belong WITH the
  change that caused them — not spread across other commits, not alone
  without their cause.

Smell test: if the one-line summary needs "and", split it.

## Workflow

1. **Read the FULL diff first** — never partition from file names alone:

   ```bash
   git status --short && git diff --stat && git diff && git diff --staged
   ```

   Include untracked files (`git status` shows them; read each).

2. **Plan the partition before staging anything.** Write the plan as a list,
   in dependency order — each commit must build on top of the previous ones:

   ```text
   1. refactor(parser): extract validate_header()   ← files a.py (hunks 1,3)
   2. fix(parser): reject empty header              ← a.py (hunk 2) + test_a.py
   3. docs: document header rules                   ← README.md
   ```

   Ordering rules: preparatory refactors first → behavior changes → tests
   with the change they test (same commit) → docs/chores last. If two units
   are truly independent, order by risk (riskiest first, easier to revert
   the tail).

3. **Stage and commit each unit in order.**
   - Whole files: `git add <paths>` (explicit paths — never `git add .`
     mid-partition).
   - A file whose hunks belong to DIFFERENT units: interactive `git add -p`
     is unavailable to agents — use the patch-editing recipe in
     [references/splitting-recipes.md](references/splitting-recipes.md).
   - Before each `git commit`, confirm the staged set matches the plan:
     `git diff --staged --stat`.

4. **Verify.** After the final commit the working tree must be clean
   (`git status --short` empty — nothing forgotten). Run the project's
   build/test on the result. If you claim each commit stands alone, prove it
   for the risky ones (recipe 4: `git rebase --exec`).

5. **Report** the resulting `git log --oneline` of new commits to the user.

## Splitting existing commits

Only on commits that are NOT pushed/shared. Last commit: `git reset HEAD~1`
then re-partition (recipe 2). Deeper history: non-interactive rebase
(recipe 3). If the branch is pushed, stop and ask — rewriting shared
history needs explicit user approval.

## Boundaries

- Never `git push`, never rewrite published history without explicit
  approval.
- Don't invent granularity: a diff that IS one logical change gets one
  commit — do not split by file or by size.
- Pre-commit hooks may mutate files (formatters): if a hook changes the
  tree, re-read the diff before continuing the partition.
