import { after } from "node:test";
const key = Symbol.for("pi-subagents:manager");
const original = globalThis[key];
const records = new Map();
const owned = Symbol("mock-settlement");
after(() => { if (original === undefined) delete globalThis[key]; else globalThis[key] = original; });

// Model the package promise in fake buses; real or explicitly controlled
// settlement promises always remain authoritative.
export function mockSettlement(name, event) {
  if (name.startsWith("subagents:rpc:spawn:reply:") && event?.success && event.data?.id) {
    const id = event.data.id;
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    records.set(id, { promise, resolve });
    const previous = globalThis[key];
    if (!previous?.[owned]) {
      globalThis[key] = { [owned]: true, getRecord(id) {
        const record = previous?.getRecord?.(id);
        const mock = records.get(id);
        return record?.promise || !mock ? record : { ...record, promise: mock.promise };
      } };
    }
  } else if (["subagents:completed", "subagents:failed"].includes(name)) {
    records.get(event?.id)?.resolve();
  }
}
