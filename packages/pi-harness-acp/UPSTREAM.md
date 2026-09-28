# Upstream provenance

This package is the current compatibility bridge derived from
[`svkozak/pi-acp`](https://github.com/svkozak/pi-acp), pinned at
`d1cffc047ab37a096ee70ca39cfc1de463db8d12` (retrieved 2026-09-17).
Upstream is MIT licensed; its `LICENSE` is retained beside this file.

Patch set:

- package and executable are renamed to `@will/pi-harness-acp` and
  `pi-harness-acp`;
- the bridge uses `@agentclientprotocol/sdk` 1.5.0 and negotiates ACP protocol
  version 1;
- Pi runs with `--mode rpc`; the bridge does not set a provider, model, or
  authentication method;
- ACP session IDs map to persisted Pi session IDs;
- ACP cancel notifications relay to Pi RPC abort;
- Pi text, thought, and tool events map to ACP session updates;
- `/plan`, `/goal`, `/skill-hub`, and `/learn` are advertised as ACP commands.

## Current upstream delta

The audited upstream `pi-acp@0.0.33` owns generic ACP well, but its documented
slash-command support excludes Pi extension commands and its package exposes an
executable rather than a supported command-projection API. The current bridge
therefore remains the single active ACP implementation; no upstream dependency
is installed.

## ACP v1 implementation and tested limits

The bridge supports ACP v1 initialization, new and resumed sessions, prompt
completion, cancellation, close, text and image content, streamed text and
thought updates, tool-call updates, and the listed extension commands. For a
normal prompt, the bridge returns `stopReason: "end_turn"` after Pi emits
`agent_settled` and queued ACP updates finish. Registered Harness extension
commands do not emit `agent_settled`; the bridge returns after the command's
notification reaches the ACP client. A cancelled prompt returns
`stopReason: "cancelled"`.

Pi 0.87.1 serializes `message_update` without its assistant `message` envelope.
The bridge uses `assistantMessageEvent` for those assistant-only updates. The
controlled Pi RPC fixture uses the same shape.

The bridge supports ACP stdio MCP servers for `session/new` and
`session/resume`. It completes each MCP initialize handshake and `tools/list`
request before Pi RPC readiness. It registers deterministic Pi tool names and
reconnects the requested server set on every resume. It rejects HTTP and SSE
transports. It does not advertise `loadSession` or model selection. Pi owns
provider, model, and authentication configuration.

The bridge launches the absolute MCP command directly with `shell: false`. It
uses the MCP SDK's safe inherited environment and applies the ACP request's
explicit environment values. MCP commands run with the user's host permissions.
This is trusted host execution, not an OS sandbox. The bridge ignores MCP stderr
and returns generic errors for failed calls. On POSIX, the bridge terminates the
MCP server's process group on session close and ACP shutdown. A server that
detaches descendants can leave processes outside that group. On Windows, the
bridge owns and terminates the direct MCP process.

Session ownership is process-local; the bridge does not lock persisted session
IDs across multiple ACP processes.

The automated ACP lifecycle and subprocess tests pass, including stdio
initialize/new/prompt/close/resume, tool execution, multiple servers, startup and
malformed-response failures, child exit, cancellation, cleanup, output secrecy,
and unsupported HTTP/SSE rejection. A packed ACP artifact includes the runtime
extension and its declared dependencies. Zed 0.229.0 GUI testing with the
registered `pi-harness` agent also passed: a prompt reached Pi and Zed displayed
`ACP GUI check passed.`. These are integration results. No official ACP
conformance suite was found, so this is not a full official ACP conformance
claim.

## RPC lifecycle boundary

A correlated native `get_state` response establishes readiness; spawn and first
stdout do not. New and restored sessions await the same bounded readiness gate.
RPC failures use bounded `PI_RPC_*` codes; exit rejects pending requests, and late
responses are discarded. `session/cancel` and `$/cancel_request` abort the Pi prompt with a separate
500 ms acknowledgement. The bridge keeps the Pi session when abort succeeds.
Cancellation during session startup stops the request; a cancelled `session/new`
cleans its owned child. Session shutdown uses native EOF, then bounded TERM/KILL
fallback if required. Ordinary RPC remains 30 s.

Pi's correlated RPC prompt response marks preflight acceptance. It does not mark
turn completion. For normal prompts, the bridge waits for `agent_settled` and all
queued session updates. A registered Harness command uses its queued completion
notification because Pi does not emit `agent_settled` for extension commands. ACP
`session/cancel` is a notification. The bridge does not fabricate a response.

The bridge targets the stable ACP v1 contract. It does not claim full official
ACP conformance. The automated suite covers the implemented lifecycle and tested
message forms. Zed GUI integration covers one text prompt and response.

Pi 0.87.1 may strand its catalog-store lock when it exits during asynchronous lock
acquisition. Subsequent Pi startup can block before RPC initialization. Readiness
fails closed and cleans its owned child, but does not delete runtime-owned locks
or guarantee catalog-refresh drain. See the T11 evidence in `todo.md`.
