import { randomUUID } from "node:crypto";

export class PiRpcError extends Error {
  constructor(code) { super(code); this.name = "PiRpcError"; this.code = code; }
}

// A response, not process spawn or stdout activity, establishes RPC readiness.
export function createPiRpc(child, { readinessTimeout = 10_000, requestTimeout = 30_000, abortTimeout = 500, drainTimeout = 1500, onEvent = () => {} } = {}) {
  const pending = new Map();
  let buffered = "", exited = false, stopping = false, stopPromise;
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const rejectPending = code => { for (const request of [...pending.values()]) request.finish(new PiRpcError(code)); };
  const finishExit = () => {
    if (exited) return;
    exited = true;
    rejectPending("PI_RPC_EXITED");
    child.stdout.off("data", onData);
    child.stdin.off("error", onInputError);
    child.off("error", onError);
    child.off("exit", finishExit);
    resolveClosed();
  };
  const onInputError = () => rejectPending("PI_RPC_WRITE_FAILED");
  const onError = () => { rejectPending("PI_RPC_SPAWN_FAILED"); finishExit(); };
  function onData(chunk) {
    buffered += chunk;
    let end;
    while ((end = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
      let message; try { message = JSON.parse(line); } catch { continue; }
      if (message.type === "response") {
        const request = pending.get(message.id);
        if (request && message.command === request.command) request.finish(message.success === true || request.acceptFailure ? null : new PiRpcError("PI_RPC_REJECTED"), message);
        continue; // Including late replies: never promote them as fresh events.
      }
      if (message.type === "extension_ui_request" && !stopping && child.stdin.writable) child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: message.id })}\n`);
      if (!stopping) onEvent(message);
    }
  }
  child.stdout.on("data", onData);
  child.stdin.on("error", onInputError);
  child.once("error", onError);
  child.once("exit", finishExit);

  function request(command, { timeout = requestTimeout, timeoutCode = "PI_RPC_TIMEOUT", duringStop = false, acceptFailure = false, signal } = {}) {
    if (exited || child.exitCode !== null || child.signalCode) return Promise.reject(new PiRpcError("PI_RPC_EXITED"));
    if (stopping && !duringStop) return Promise.reject(new PiRpcError("PI_RPC_CANCELLED"));
    if (signal?.aborted) return Promise.reject(new PiRpcError("PI_RPC_CANCELLED"));
    if (!child.stdin.writable) return Promise.reject(new PiRpcError("PI_RPC_WRITE_FAILED"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => finish(new PiRpcError(timeoutCode)), timeout);
      const onAbort = () => finish(new PiRpcError("PI_RPC_CANCELLED"));
      function finish(error, response) {
        if (settled) return;
        settled = true; clearTimeout(timer); signal?.removeEventListener("abort", onAbort); pending.delete(id);
        if (error) reject(error); else resolve(response);
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      pending.set(id, { command: command.type, acceptFailure, finish });
      try { child.stdin.write(`${JSON.stringify({ ...command, id })}\n`, error => { if (error) finish(new PiRpcError("PI_RPC_WRITE_FAILED")); }); }
      catch { finish(new PiRpcError("PI_RPC_WRITE_FAILED")); }
    });
  }
  async function waitForExit() {
    if (exited) return true;
    let timer;
    const result = await Promise.race([closed.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), drainTimeout); })]);
    clearTimeout(timer); return result;
  }
  function stop({ abort = true } = {}) {
    if (stopPromise) return stopPromise;
    stopping = true;
    rejectPending("PI_RPC_CANCELLED");
    stopPromise = (async () => {
      if (exited) return;
      if (abort) try { await request({ type: "abort" }, { timeout: abortTimeout, duringStop: true }); } catch {}
      // Prefer native dispose over immediate TERM. This does not guarantee
      // catalog-refresh drain: Pi 0.87.1 exposes no RPC for that background job.
      if (child.stdin.writable) child.stdin.end();
      if (await waitForExit()) return;
      child.kill("SIGTERM");
      if (await waitForExit()) return;
      child.kill("SIGKILL");
      if (!await waitForExit()) throw new PiRpcError("PI_RPC_CLEANUP_FAILED");
    })();
    return stopPromise;
  }
  const ready = request({ type: "get_state" }, { timeout: readinessTimeout, timeoutCode: "PI_RPC_NOT_READY" }).then(response => {
    if (typeof response.data?.sessionId !== "string") throw new PiRpcError("PI_RPC_INVALID_STATE");
    return response.data;
  }).catch(async error => { await stop({ abort: false }); throw error; });
  void ready.catch(() => {});
  return { ready, request, stop, closed, pending, get exited() { return exited; } };
}
