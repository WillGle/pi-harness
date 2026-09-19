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

## Deferred upstream consolidation

The cleanup audit inspected upstream `pi-acp@0.0.33`. It owns the generic ACP
v1 agent, Pi RPC process/session lifecycle, streaming/tool translation,
persistence/history, cancellation, and errors, but its command projection
explicitly excludes Pi extension commands and exposes no adapter hook for
adding them. Therefore this wave keeps the bridge unchanged as a temporary
compatibility boundary.

One final ACP implementation wave remains: run upstream `pi-acp` as the generic
owner and add only the Harness command projection for `/plan`, `/goal`,
`/learn`, and `/skill-hub`, with legacy `get_commands`, `session/inspect`, and
`session/command` support only if existing clients still require them. Do not
retain two generic ACP stacks after that migration.

This package does not claim ACP/Zed acceptance: that is a release gate and must
be run against the installed executable.
