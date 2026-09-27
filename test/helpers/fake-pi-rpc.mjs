#!/usr/bin/env node
// Deliberately controlled Pi protocol peer: no model requests or credentials.
import { writeFileSync } from "node:fs";

const index = process.argv.indexOf("--session-id");
const id = process.argv[index + 1];
const mode = process.env.FIXTURE_PI_MODE;
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const reply = (request, data) => send({ type: "response", id: request.id, command: request.type, success: true, ...(data ? { data } : {}) });
const writeMarker = (path, value) => { if (path) writeFileSync(path, String(value)); };
writeMarker(process.env.FIXTURE_PI_PID_PATH, process.pid);
writeMarker(process.env.FIXTURE_PI_SESSION_PATH, id);
let buffer = "";
process.stdin.on("data", chunk => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf("\n")) >= 0) {
    const request = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    if (request.type === "get_state") {
      if (mode !== "never") setTimeout(() => reply(request, { sessionId: id }), ["delay", "settle-delay"].includes(mode) ? 150 : 0);
    } else if (request.type === "abort") {
      reply(request);
      setImmediate(() => send({ type: "agent_settled" }));
    } else if (request.type === "prompt") {
      writeMarker(process.env.FIXTURE_PI_PROMPT_PATH, request.message);
      if (mode !== "pending") {
        if (request.message.startsWith("/")) {
          send({ type: "extension_ui_request", id: `ui-${request.id}`, method: "notify", message: "fixture response", notifyType: "info" });
        } else {
          send({ type: "message_start", message: { role: "assistant" } });
          send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "fixture response" } });
        }
        reply(request);
        const settle = () => send({ type: "agent_settled" });
        if (mode === "settle-delay" && !request.message.startsWith("/")) setTimeout(settle, 100);
        else setImmediate(settle);
      }
    }
  }
});
process.stdin.on("end", () => process.exit(0));
