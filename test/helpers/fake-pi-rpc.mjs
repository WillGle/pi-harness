#!/usr/bin/env node
// Deliberately controlled Pi protocol peer: no model requests or credentials.
const id = process.argv[process.argv.indexOf("--session-id") + 1];
const mode = process.env.FIXTURE_PI_MODE;
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
const reply = (request, data) => send({ type: "response", id: request.id, command: request.type, success: true, ...(data ? { data } : {}) });
let buffer = "";
process.stdin.on("data", chunk => {
  buffer += chunk; let end;
  while ((end = buffer.indexOf("\n")) >= 0) {
    const request = JSON.parse(buffer.slice(0,end)); buffer = buffer.slice(end+1);
    if (request.type === "get_state") {
      send({ type: "fixture_startup", pid: process.pid });
      if (mode !== "never") setTimeout(() => reply(request, { sessionId: id }), 150);
    } else if (request.type === "abort") reply(request);
    else if (request.type === "prompt" && mode === "pending") send({ type: "fixture_prompt", pid: process.pid });
    else if (request.type === "prompt") reply(request);
  }
});
process.stdin.on("end", () => process.exit(0));
