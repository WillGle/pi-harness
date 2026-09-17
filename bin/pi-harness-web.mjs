#!/usr/bin/env node
export const MAX_BYTES = 1_000_000;
export const TIMEOUT_MS = 10_000;
const [command, value] = process.argv.slice(2);
export function searchRequest(query) {
  const key = process.env.BRAVE_SEARCH_API_KEY?.trim();
  if (key && !key.startsWith("your_") && key !== "placeholder") {
    return { url: `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}`, headers: { Accept: "application/json", "X-Subscription-Token": key }, provider: "Brave" };
  }
  return { url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, headers: {}, provider: "DuckDuckGo HTML" };
}
export async function cappedBody(response, limit = MAX_BYTES) {
  if (!response.body) return "";
  const reader = response.body.getReader(); const chunks = []; let total = 0;
  try {
    for (;;) {
      const { done, value: chunk } = await reader.read(); if (done) break;
      const remaining = limit - total;
      if (remaining <= 0) { await reader.cancel(); break; }
      const kept = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
      chunks.push(kept); total += kept.byteLength;
      if (kept.byteLength !== chunk.byteLength) { await reader.cancel(); break; }
    }
  } finally { reader.releaseLock(); }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  if (!["search", "fetch"].includes(command) || !value) { console.error("Usage: pi-harness-web search <query> | fetch <url>"); process.exit(2); }
  try {
    try { process.loadEnvFile?.(); } catch {}
    let request = command === "search" ? searchRequest(value) : { url: value, headers: {}, provider: "direct URL" };
    let response = await fetch(request.url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { "user-agent": "pi-harness/1.0", ...request.headers } });
    if (!response.ok && request.provider === "Brave") {
      request = { url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(value)}`, headers: {}, provider: "DuckDuckGo HTML (fallback)" };
      response = await fetch(request.url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { "user-agent": "pi-harness/1.0" } });
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await cappedBody(response);
    const title = body.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() ?? "";
    console.log(JSON.stringify({ query: command === "search" ? value : undefined, url: response.url, title, provider: request.provider, bytes: Buffer.byteLength(body), truncated: Buffer.byteLength(body) >= MAX_BYTES, body }, null, 2));
  } catch (error) { console.error(`pi-harness-web: ${error.message}`); process.exit(1); }
}
