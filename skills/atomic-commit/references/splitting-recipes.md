# Splitting recipes — non-interactive git surgery

All recipes work without interactive prompts (`git add -p`, `git rebase -i`
with an editor are unavailable to agents). Every recipe assumes a repo-local
scratch dir or the agent's scratchpad for temp patch files — never leave
`.patch` files in the working tree.

## Recipe 1 — stage SOME hunks of a file (patch editing)

Goal: file `a.py` has 3 hunks; hunks 1 and 3 belong to commit A, hunk 2 to
commit B.

```bash
git diff -- a.py > /tmp/a.patch        # full diff of the file
# Edit /tmp/a.patch: DELETE the hunks that do NOT belong to this commit.
# A hunk starts at a line beginning with @@ and runs until the next @@.
# Keep the file header (diff --git / --- / +++) intact.
git apply --cached /tmp/a.patch        # stage only the kept hunks
git diff --staged -- a.py              # verify staged == intended
```

The working tree still contains ALL changes; only the index is partial.
Commit, then the remaining hunks are still unstaged for the next commit.

Line-number drift: deleting a hunk does NOT require renumbering the
remaining hunks' `@@` headers — `git apply` tolerates offsets. If it
rejects, add `--recount`:

```bash
git apply --cached --recount /tmp/a.patch
```

Inverse check — what remains unstaged after staging: `git diff -- a.py`.

## Recipe 2 — split the LAST commit

```bash
git reset HEAD~1        # commit undone, changes back in working tree, tree untouched
# now partition as usual (workflow step 2–3)
```

Preserve the original message parts worth keeping: `git log --format=%B -1
ORIG_HEAD` before resetting.

## Recipe 3 — split a commit deeper in (unpushed) history

Example: split commit `abc1234` on current branch.

```bash
# 1. Non-interactive rebase: mark the target commit for editing
GIT_SEQUENCE_EDITOR='sed -i "s/^pick abc1234/edit abc1234/"' \
  git rebase -i abc1234~1

# 2. Rebase stops AT abc1234, already applied. Undo it in place:
git reset HEAD~1

# 3. Re-partition into atomic commits (recipes 1 + workflow)

# 4. Replay the rest of the branch on top:
git rebase --continue
```

If later commits conflict with the new split, resolve normally; the split
must not change the final tree — verify with `git diff <old-tip>` → empty.

## Recipe 4 — prove every commit builds

Run a check on EACH commit of the new range without touching the branch
outcome:

```bash
GIT_SEQUENCE_EDITOR=true git rebase --exec '<build/test command>' <base>
```

`--exec` runs the command after each replayed commit; the rebase aborts at
the first failing commit, telling you exactly which unit is not standalone.
Fix by amending that unit (`git commit --amend` at the stopped position,
then `git rebase --continue`).

Cheaper spot-check for one commit:

```bash
git stash push --keep-index   # hide unstaged noise, keep staged/committed state
<build/test>
git stash pop
```

## Recipe 5 — untangle refactor + behavior change in the same lines

When the same lines contain both (rename + logic fix), patch editing can't
separate them. Reconstruct instead:

```bash
git stash push -- <file>              # park the combined change
# Re-apply ONLY the refactor by hand (or scripted sed for a rename)
git add <file> && git commit          # commit 1: pure refactor
git stash pop                          # combined change returns; refactor
                                       # part now merges cleanly, leaving
git add <file> && git commit          # commit 2: pure behavior change
```

If `stash pop` conflicts, resolve keeping both intents — the conflict is
exactly the entangled region.

## Pitfalls

| Pitfall | Handling |
|---|---|
| Pre-commit hook reformats files during commit | after every commit, `git status --short`; if dirty, fold hook output into the commit it belongs to (`git add -u && git commit --amend`) |
| Lockfile / generated-file hunks | always ride with the commit that caused them; if two units both touch the lockfile, use recipe 1 on the lockfile too — or regenerate per commit |
| Whitespace-only hunks polluting a logic commit | move them to a final `style:` commit (or drop them) |
| `git add .` reflex | forbidden mid-partition — always explicit paths |
| Untracked new files forgotten | `git status --short` after the last commit must be empty |
| Split changes final tree | after any history surgery: `git diff <original-tip>` must be empty |
