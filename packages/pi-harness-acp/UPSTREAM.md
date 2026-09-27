# Upstream provenance

This package is the current compatibility bridge derived from
[`svkozak/pi-acp`](https://github.com/svkozak/pi-acp), pinned at
`d1cffc047ab37a096ee70ca39cfc1de463db8d12` (retrieved 2026-09-17).
Upstream is MIT licensed; its `LICENSE` is retained beside this file.

Patch set:

- package and executable are renamed to `@will/pi-harness-acp` and
  `pi-harness-acp`;
- Pi is always spawned as `pi --mode rpc`; no provider, model, authentication,
  alias, secret, or environment variable is introduced by this bridge;
- persisted ACP-to-Pi session IDs, cancellation relay, Pi event forwarding,
  and merged `/plan` and `/goal` extension command discovery are added.

## Current upstream delta

The audited upstream `pi-acp@0.0.33` owns generic ACP well, but its documented
slash-command support excludes Pi extension commands and its package exposes an
executable rather than a supported command-projection API. The current bridge
therefore remains the single active ACP implementation; no upstream dependency
is installed.

This package does not claim ACP/Zed acceptance: that is a release gate and must
be run against the installed executable.

## RPC lifecycle boundary

A correlated native `get_state` response establishes readiness; spawn and first
stdout do not. New and restored sessions await the same bounded readiness gate.
RPC failures use bounded `PI_RPC_*` codes; exit rejects pending requests, and late
responses are discarded. Cancellation uses a separate 500 ms abort acknowledgement,
native EOF shutdown, then bounded TERM/KILL fallback. Ordinary RPC remains 30 s.

The bridge preserves its existing custom acceptance response. Pi prompt preflight
acceptance is not terminal completion; `agent_settled` is forwarded separately.
This is not a claim of ACP v1 conformance: the
[official v1 contract](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v1/overview.mdx)
returns a stop reason after the turn, while
[v2](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v2/overview.mdx)
separates acceptance and idle updates. No protocol migration is bundled into this fix.
Cancel notifications do not receive a fabricated JSON-RPC response; legacy
cancel requests still receive the existing acknowledgement after process exit.

Pi 0.87.1 may strand its catalog-store lock when it exits during asynchronous lock
acquisition. Subsequent Pi startup can block before RPC initialization. Readiness
fails closed and cleans its owned child, but does not delete runtime-owned locks
or guarantee catalog-refresh drain. See the T11 evidence in `todo.md`.
