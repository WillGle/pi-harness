import test from "node:test";
import assert from "node:assert/strict";
import { GOAL_ENTRY, PLAN_ENTRY, cavemanSummary, goalState, isPlanAllowedTool, isReadOnlyBash, parsePlan, planState, restore, transitionGoal } from "../lib/state.mjs";

test("restores the newest persisted state", () => assert.equal(restore([{ customType: PLAN_ENTRY, data: planState(false) }, { customType: PLAN_ENTRY, data: planState(true) }], PLAN_ENTRY).enabled, true));
test("plan parser and bash gate reject mutation", () => {
  assert.equal(parsePlan(" ON "), "on"); assert.throws(() => parsePlan("toggle")); assert.equal(isReadOnlyBash("rg TODO src | head -5"), true);
  for (const command of ["echo x > a", "git status; rm a", "curl https://x", "unknown --flag", "find . -exec rm {} \\;", "git config user.name x", "rg x $(pwd)"]) assert.equal(isReadOnlyBash(command), false);
  for (const tool of ["write", "edit", "pi_harness_coordinate"]) assert.equal(isPlanAllowedTool(tool), false);
  assert.equal(isPlanAllowedTool("bash", { command: "git status" }), true);
});
test("goals require terminal evidence and a blocker where applicable", () => {
  const goal = goalState("verify harness"); assert.throws(() => transitionGoal(goal, "complete")); assert.throws(() => transitionGoal(goal, "blocked", "gate failed"));
  const done = transitionGoal(goal, "complete", "npm test passed"); assert.equal(done.status, "complete"); assert.equal(restore([{ customType: GOAL_ENTRY, data: done }], GOAL_ENTRY).objective, "verify harness");
});
test("caveman compaction summary retains required state", () => {
  const compact = cavemanSummary({ goal: goalState("finish"), plan: planState(true, ["inspect"]), decisions: ["minimal"], changedFiles: ["a"], gates: ["test"], blocker: "none" });
  for (const key of ["goal", "plan", "decisions", "changedFiles", "gates", "blocker"]) assert.ok(key in compact);
});
