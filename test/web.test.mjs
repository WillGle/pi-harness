import test from "node:test";
import assert from "node:assert/strict";
import { MAX_BYTES, TIMEOUT_MS, cappedBody, searchRequest } from "../bin/pi-harness-web.mjs";

test("web body cap cancels after the configured number of bytes", async () => {
  let cancelled = false;
  const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("abcdefgh")); }, cancel() { cancelled = true; } });
  const text = await cappedBody(new Response(body), 4);
  assert.equal(text, "abcd"); assert.equal(cancelled, true);
});

test("web provenance: default DuckDuckGo provider and URL encoding", () => {
  const originalKey = process.env.BRAVE_SEARCH_API_KEY;
  delete process.env.BRAVE_SEARCH_API_KEY;
  try {
    const req = searchRequest("pi harness query with spaces & symbols");
    assert.equal(req.provider, "DuckDuckGo HTML");
    assert.ok(req.url.startsWith("https://html.duckduckgo.com/html/?q="));
    assert.ok(req.url.includes(encodeURIComponent("pi harness query with spaces & symbols")));
    assert.deepEqual(req.headers, {});
  } finally {
    if (originalKey) process.env.BRAVE_SEARCH_API_KEY = originalKey;
  }
});

test("web provenance: Brave provider when API key configured", () => {
  const originalKey = process.env.BRAVE_SEARCH_API_KEY;
  process.env.BRAVE_SEARCH_API_KEY = "test-token-xyz";
  try {
    const req = searchRequest("test query");
    assert.equal(req.provider, "Brave");
    assert.ok(req.url.startsWith("https://api.search.brave.com"));
    assert.equal(req.headers["X-Subscription-Token"], "test-token-xyz");
  } finally {
    if (originalKey) process.env.BRAVE_SEARCH_API_KEY = originalKey;
    else delete process.env.BRAVE_SEARCH_API_KEY;
  }
});

test("web limits: timeout and max byte cap constraints", () => {
  assert.equal(TIMEOUT_MS, 10_000, "Timeout must be bounded at 10,000ms");
  assert.equal(MAX_BYTES, 1_000_000, "Max bytes must be capped at 1,000,000 bytes");
});
