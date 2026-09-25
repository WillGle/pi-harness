---
name: security
description: Defensive code and architecture security reasoning for explicitly requested review.
disable-model-invocation: true
---
# Defensive security reasoning

Use this skill only when the user explicitly invokes `/skill:security`. This skill is reasoning guidance, not a verifier or a model selection mechanism. It does not dispatch agents or accept results.

1. Identify assets, entry points, trust boundaries, privilege boundaries, and attacker-controlled inputs. Trace each input to a sensitive sink and show the actual code path. Distinguish authentication (identity) from authorization (permission per object and action). Check session and token issuance, expiry, rotation, storage, revocation, and credential handling.
2. At each boundary inspect input validation, encoding and injection (SQL, template, shell), command execution with argument separation, path traversal and symlink escapes, SSRF including redirects and DNS, unsafe deserialization, and insecure defaults. Check file permissions, ownership, time-of-check/time-of-use races, concurrency and shared-state safety.
3. Check secrets and cryptographic use: key generation, entropy, algorithm/mode, nonce reuse, verification before use, storage and rotation. Find sensitive data exposure in responses, errors, telemetry, logs, and PII handling. Check dependency provenance, lockfiles, build scripts, and supply-chain exposure.
4. Check resource exhaustion: unbounded inputs, recursion, request fan-out, allocations, timeouts and quotas. Check that errors fail safely without revealing credentials or bypassing privilege checks.
5. For each finding state the affected path, attacker precondition, trust boundary crossed, concrete impact, evidence and uncertainty. Do not claim an exploit from a keyword alone. Propose the smallest defensive patch, security regression tests (including denied cases), and patch validation against the original issue and nearby bypasses. If the Evidence does not establish a claim, say so.
