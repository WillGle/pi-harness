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
