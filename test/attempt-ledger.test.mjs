import test from "node:test";
import assert from "node:assert/strict";
import * as ledger from "../lib/attempt-ledger.mjs";

const attempt = (ordinal, status = "running", fields = {}) => ({ version: 1, attempt_id: `A-O-1-T-1-0${ordinal}`, mission_id: "M-1", operation_id: "O-1", task_id: "T-1", ordinal, status, ...fields });

test("unstarted Attempt rollback removes only the exact latest running Attempt", () => {
  const previous = attempt(1, "execution_complete"), current = attempt(2), sibling = { ...attempt(1), attempt_id: "A-O-1-T-2-01", task_id: "T-2" };
  const entries = { [previous.attempt_id]: previous, [current.attempt_id]: current, [sibling.attempt_id]: sibling };
  assert.equal(typeof ledger.rollbackUnstartedAttempt, "function");
  const next = ledger.rollbackUnstartedAttempt(entries, current.attempt_id);
  assert.deepEqual(next, { [previous.attempt_id]: previous, [sibling.attempt_id]: sibling });
  assert.equal(entries[current.attempt_id], current);
});

test("unstarted Attempt rollback rejects settled, older, missing, and child-owned Attempts", () => {
  assert.equal(typeof ledger.rollbackUnstartedAttempt, "function");
  for (const fields of [{ status: "unknown" }, { status: "execution_complete" }, { child_id: "worker-1" }, { child_ref: "worker-1" }]) {
    const current = attempt(1, "running", fields);
    assert.throws(() => ledger.rollbackUnstartedAttempt({ [current.attempt_id]: current }, current.attempt_id));
  }
  const older = attempt(1), latest = attempt(2);
  assert.throws(() => ledger.rollbackUnstartedAttempt({ [older.attempt_id]: older, [latest.attempt_id]: latest }, older.attempt_id));
  assert.throws(() => ledger.rollbackUnstartedAttempt({}, older.attempt_id));
});
