import test from "node:test";
import assert from "node:assert/strict";
import { PLAN_ENTRY, isPlanAllowedTool, isReadOnlyBash, parsePlan, planState, restore } from "../lib/plan.mjs";
import { createWork, finishWork, workSituation, WORK_ENTRY } from "../lib/work.mjs";

test("restores the newest persisted state", () => assert.equal(restore([{ customType: PLAN_ENTRY, data: planState(false) }, { customType: PLAN_ENTRY, data: planState(true) }], PLAN_ENTRY).enabled, true));
test("plan parser and bash gate reject mutation", () => {
  assert.equal(parsePlan(" ON "), "on"); assert.throws(() => parsePlan("toggle")); assert.equal(isReadOnlyBash("rg TODO src | head -5"), true);
  for (const command of ["echo x > a", "git status; rm a", "curl https://x", "unknown --flag", "find . -exec rm {} \\;", "git config user.name x", "rg x $(pwd)"]) assert.equal(isReadOnlyBash(command), false);
  for (const tool of ["write", "edit", "pi_harness_coordinate"]) assert.equal(isPlanAllowedTool(tool), false);
  assert.equal(isPlanAllowedTool("bash", { command: "git status" }), true);
});
test("work requires terminal evidence and a blocker where applicable", () => {
  const work = createWork("verify harness"); assert.throws(() => finishWork(work, "complete")); assert.throws(() => finishWork(work, "blocked", "gate failed"));
  const done = finishWork(work, "complete", "npm test passed"); assert.equal(done.status, "complete"); assert.equal(restore([{ customType: WORK_ENTRY, data: done }], WORK_ENTRY).objective, "verify harness");
});
test("work context retains the original objective and constraints without rewriting them", () => {
  const summary = workSituation(createWork("finish", ["Preserve the public API."]));
  assert.match(summary, /Original objective: finish/);
  assert.match(summary, /Constraint: Preserve the public API/);
});
