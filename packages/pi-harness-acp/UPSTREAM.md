# Upstream provenance

This package is a maintained fork boundary for
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

The patch intentionally does not claim ACP/Zed acceptance: that is a release
gate and must be run against the installed executable.
