import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storeEvidence } from "../lib/evidence.mjs";
import { OPERATION_ENTRY, acceptOperationCriterion, acceptTaskResult, createOperation, recordTaskResult, rejectTaskResult } from "../lib/operation.mjs";
import { GOAL_ENTRY, goalState, restore } from "../lib/state.mjs";

const verified = (operation_id, task_id) => ({ version: 1, operation_id, task_id, execution_status: "execution_complete", verification_status: "verified", evidence_refs: [] });
const make = () => createOperation({ operation_id: "O-1", objective: "Coordinate two TaskOrders.", required_task_ids: ["T-1", "T-2"], acceptance_criteria: ["The Operation result is documented."], dependencies: { "T-2": ["T-1"] } });

test("Coordinator alone accepts recorded verified TaskResults and satisfied Dependencies", () => {
  let op = make();
  assert.throws(() => acceptTaskResult(op, "T-1"), /requires a verified/);
  op = recordTaskResult(op, { ...verified("O-1", "T-1"), verification_status: "not_verified", success: true });
  assert.throws(() => acceptTaskResult(op, "T-1"), /requires a verified/);
  op = recordTaskResult(op, verified("O-1", "T-1"));
  op = recordTaskResult(op, verified("O-1", "T-2"));
  assert.throws(() => acceptTaskResult(op, "T-2"), /Dependency/);
  op = acceptTaskResult(op, "T-1");
  assert.equal(op.status, "open");
  assert.throws(() => acceptTaskResult(op, "T-1"), /again/);
  op = acceptTaskResult(op, "T-2");
  assert.equal(op.status, "open", "Operation-level criterion is not accepted");
  assert.deepEqual(op.accepted_task_ids, ["T-1", "T-2"]);
});

test("Operation completes only after explicit criterion acceptance; Mission remains separate", () => {
  const temp = mkdtempSync(join(tmpdir(), "pi-op-evidence-"));
  const old = process.env.PI_HARNESS_EVIDENCE_DIR;
  process.env.PI_HARNESS_EVIDENCE_DIR = join(temp, "store");
  try {
    const evidence = storeEvidence({ taskId: "T-1", kind: "report", content: "The Coordinator checked the Operation result." });
    const foreign = storeEvidence({ taskId: "T-other", kind: "report", content: "Unrelated result." });
    let op = recordTaskResult(make(), verified("O-1", "T-1"));
    op = recordTaskResult(op, verified("O-1", "T-2"));
    assert.throws(() => acceptOperationCriterion(op, "The Operation result is documented.", ["evidence://foreign/invalid"]));
    assert.throws(() => acceptOperationCriterion(op, "The Operation result is documented.", [foreign.reference]), /required TaskOrder/);
    op = acceptOperationCriterion(op, "The Operation result is documented.", [evidence.reference]);
    assert.equal(op.status, "open");
    op = acceptTaskResult(op, "T-1");
    op = acceptTaskResult(op, "T-2");
    assert.equal(op.status, "complete");
    assert.match(op.acceptance_summary, /Commander must still evaluate the Mission/);
    const mission = goalState("Mission DoD requires approval.");
    assert.equal(restore([{ customType: OPERATION_ENTRY, data: { "O-1": op } }], OPERATION_ENTRY)["O-1"].status, "complete");
    assert.equal(restore([{ customType: GOAL_ENTRY, data: mission }], GOAL_ENTRY).status, "active");
    assert.throws(() => recordTaskResult(op, verified("O-1", "T-1")));
  } finally {
    if (old === undefined) delete process.env.PI_HARNESS_EVIDENCE_DIR;
    else process.env.PI_HARNESS_EVIDENCE_DIR = old;
    rmSync(temp, { recursive: true, force: true });
  }
});

test("foreign, failed, blocked and superseded TaskResults fail closed", () => {
  let op = make();
  assert.throws(() => recordTaskResult(op, verified("O-other", "T-1")));
  assert.throws(() => recordTaskResult(op, verified("O-1", "T-other")));
  for (const status of ["failed", "blocked", "not_verified"]) {
    const state = recordTaskResult(op, { ...verified("O-1", "T-1"), verification_status: status });
    assert.throws(() => acceptTaskResult(state, "T-1"));
  }
  op = recordTaskResult(op, verified("O-1", "T-1"));
  op = rejectTaskResult(op, "T-1");
  assert.throws(() => acceptTaskResult(op, "T-1"));
  assert.throws(() => rejectTaskResult(op, "T-1"));
  op = recordTaskResult(op, verified("O-1", "T-1"));
  assert.deepEqual(op.rejected_task_ids, [], "a newer TaskResult supersedes the rejected one");
  op = recordTaskResult(op, { ...verified("O-1", "T-1"), verification_status: "failed" });
  assert.throws(() => acceptTaskResult(op, "T-1"), /requires a verified/);
  assert.throws(() => createOperation({ operation_id: "O-1", objective: "bad", required_task_ids: ["T-1", "T-1"] }));
});
