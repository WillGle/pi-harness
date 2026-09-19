import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { MAX_BYTES, MAX_REDIRECTS, TIMEOUT_MS, cappedBody, searchRequest } from "../bin/pi-harness-web.mjs";

const CLI_PATH = fileURLToPath(new URL("../bin/pi-harness-web.mjs", import.meta.url));

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
  assert.equal(MAX_REDIRECTS, 5, "Redirects must be explicitly bounded");
});

test("web security: direct fetch rejects loopback before network access", async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.end("local response");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const { port } = server.address();
    const child = spawn(process.execPath, [CLI_PATH, "fetch", `http://127.0.0.1:${port}/secret`], { cwd: tmpdir() });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const result = await new Promise((resolve) => {
      child.on("close", (code, signal) => resolve({ code, signal }));
    });

    assert.equal(result.code, 1);
    assert.equal(result.signal, null);
    assert.equal(requests, 0);
    assert.match(stderr, /pi-harness-web: Blocked or invalid fetch URL/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("web security: loopback-resolving hostname cannot reach redirect target", async () => {
  const target = createServer((_request, response) => {
    target.requests = (target.requests ?? 0) + 1;
    response.end("private response");
  });
  await new Promise((resolve, reject) => {
    target.once("error", reject);
    target.listen(0, "127.0.0.1", resolve);
  });

  try {
    const { port } = target.address();
    const child = spawn(process.execPath, [CLI_PATH, "fetch", `http://lvh.me:${port}/redirect`], {
      cwd: tmpdir(),
      env: { ...process.env, NO_PROXY: `${process.env.NO_PROXY ?? ""},lvh.me` },
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const result = await new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
    assert.equal(result.code, 1);
    assert.equal(result.signal, null);
    assert.equal(target.requests ?? 0, 0);
    assert.match(stderr, /pi-harness-web: Blocked or invalid fetch URL/);
  } finally {
    await new Promise((resolve) => target.close(resolve));
  }
});
