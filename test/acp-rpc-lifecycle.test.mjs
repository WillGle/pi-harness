import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { createPiRpc, PiRpcError } from "../packages/pi-harness-acp/lib/pi-rpc.mjs";

function fixture({ replyReady = true, replyAbort = true, eofExit = true, ignoreTerm = false } = {}) {
  const child = new EventEmitter();
  child.exitCode = null; child.signalCode = null; child.stdout = new PassThrough();
  const commands = [], kills = [];
  const exit = signal => { if (child.exitCode !== null || child.signalCode) return; child.exitCode = signal ? null : 0; child.signalCode = signal; child.emit("exit", child.exitCode, signal); };
  const reply = request => child.stdout.write(JSON.stringify({ id: request.id, type: "response", command: request.type, success: true, ...(request.type === "get_state" ? { data: { sessionId: "S-owned" } } : {}) }) + "\n");
  child.stdin = new Writable({ write(chunk, _encoding, callback) {
    const command = JSON.parse(String(chunk)); commands.push(command);
    if ((command.type === "get_state" && replyReady) || (command.type === "abort" && replyAbort)) reply(command);
    callback();
  }, final(callback) { callback(); if (eofExit) queueMicrotask(() => exit()); } });
  child.kill = signal => { kills.push(signal); if (signal !== "SIGTERM" || !ignoreTerm) exit(signal); return true; };
  const events = [];
  const rpc = createPiRpc(child, { readinessTimeout: 25, requestTimeout: 15, abortTimeout: 10, drainTimeout: 10, onEvent: event => events.push(event) });
  return { child, commands, kills, rpc, reply, exit, events };
}

test("RPC readiness is a matching native get_state response, not arbitrary stdout", async () => {
  const f = fixture({ replyReady: false });
  let ready = false; void f.rpc.ready.then(() => { ready = true; });
  f.child.stdout.write(JSON.stringify({ type: "startup" }) + "\n");
  await Promise.resolve(); assert.equal(ready, false); assert.equal(f.rpc.pending.size, 1);
  f.reply(f.commands[0]); assert.equal((await f.rpc.ready).sessionId, "S-owned");
  await f.rpc.stop(); assert.equal(f.rpc.pending.size, 0);
});

test("RPC readiness deadline rejects typed failure and cleans the owned child", async () => {
  const f = fixture({ replyReady: false });
  await assert.rejects(f.rpc.ready, error => error instanceof PiRpcError && error.code === "PI_RPC_NOT_READY");
  assert.equal(f.rpc.exited, true); assert.equal(f.rpc.pending.size, 0);
  assert.equal(f.child.stdout.listenerCount("data"), 0); assert.equal(f.child.listenerCount("exit"), 0);
});

test("child exit immediately rejects every pending RPC and removes timers/listeners", async () => {
  const f = fixture(); await f.rpc.ready;
  const requests = [f.rpc.request({ type: "prompt" }), f.rpc.request({ type: "get_commands" })];
  const results = Promise.allSettled(requests); f.exit();
  for (const value of await results) { assert.equal(value.status, "rejected"); assert.equal(value.reason.code, "PI_RPC_EXITED"); }
  assert.equal(f.rpc.pending.size, 0); assert.equal(f.child.stdin.listenerCount("error"), 0);
});

test("RPC timeout rejects rather than undefined; a late reply cannot resurrect it", async () => {
  const f = fixture(); await f.rpc.ready;
  const request = f.rpc.request({ type: "prompt" });
  await assert.rejects(request, { code: "PI_RPC_TIMEOUT" });
  assert.equal(f.rpc.pending.size, 0); f.reply(f.commands.at(-1));
  assert.equal(f.events.length, 0); assert.equal(f.rpc.pending.size, 0); await f.rpc.stop();
});

test("cancel during startup rejects readiness without waiting for its normal deadline", async () => {
  const f = fixture({ replyReady: false });
  const rejection = assert.rejects(f.rpc.ready, { code: "PI_RPC_CANCELLED" });
  await f.rpc.stop(); await rejection;
  assert.equal(f.rpc.exited, true); assert.equal(f.rpc.pending.size, 0);
});

test("cancel with an outstanding prompt rejects it and acknowledges abort independently", async () => {
  const f = fixture(); await f.rpc.ready;
  const rejected = assert.rejects(f.rpc.request({ type: "prompt" }), { code: "PI_RPC_CANCELLED" });
  await f.rpc.stop(); await rejected;
  assert.equal(f.commands.at(-1).type, "abort"); assert.equal(f.rpc.pending.size, 0); assert.equal(f.rpc.exited, true);
});

test("ignored abort/EOF/TERM still reaches bounded exact-child KILL fallback", async () => {
  const f = fixture({ replyAbort: false, eofExit: false, ignoreTerm: true }); await f.rpc.ready;
  const stop = f.rpc.stop(); assert.equal(f.rpc.stop(), stop); await stop;
  assert.deepEqual(f.kills, ["SIGTERM", "SIGKILL"]); assert.equal(f.rpc.pending.size, 0); assert.equal(f.rpc.exited, true);
});
