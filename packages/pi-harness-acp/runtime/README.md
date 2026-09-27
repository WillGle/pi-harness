# Pi 0.87.1 catalog shutdown patch

This is a runtime build patch, not an ACP feature or an installed Pi replacement.
The bridge cannot drain Pi's private catalog controller through RPC.

Pi's public refresh/read promises can settle on abort while physical provider or
catalog-lock work is still pending. The patch tracks that work, aborts the RPC
background catalog refresh on native runtime disposal, and drains provider work,
publication chains and physical catalog storage operations before disposal exits.
Ordinary refresh cancellation semantics, model/provider selection and existing
deadlines are unchanged. Forced KILL cannot guarantee graceful lock release.

Apply to a disposable upstream **0.87.1 monorepo build tree** after its normal
build and before packaging/installing:

```sh
node /path/to/runtime/apply-catalog-drain.mjs /path/to/pi-monorepo
```

The script validates all version/source anchors first and rebuilds the actual
bundled CLI. It must not be run against `/nix/store` or the active user's agent
directory. Nix deployment belongs in the existing Pi package derivation's build
hook; do not introduce a second PATH shim or mutate generated system links.
Neither the Nix installation nor the repository's npm-installed Pi has been
changed by the disposable validation. T11 remains PARTIAL until the build hook
and default runtime path are verified with repeated regressions.

Regression tests, using the repository's exact Pi dependency without credentials
or network calls:

```sh
node packages/pi-harness-acp/runtime/catalog-drain.test.mjs
```
