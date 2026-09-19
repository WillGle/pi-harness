#!/usr/bin/env node
export const MAX_BYTES = 1_000_000;
export const TIMEOUT_MS = 10_000;
export const MIN_HTML_TEXT_BYTES = 500;
export const JINA_READER_URL = "https://r.jina.ai/";
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
export function htmlText(body) {
  return body.replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
export function needsJinaFallback(response, body) {
  return response.headers.get("content-type")?.toLowerCase().includes("text/html") && Buffer.byteLength(htmlText(body)) < MIN_HTML_TEXT_BYTES;
}
export function jinaReaderUrl(value) {
  const url = new URL(value);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const ipv4 = host.split(".").map(Number);
  const privateIpv4 = ipv4.length === 4 && ipv4.every(Number.isInteger) && (
    ipv4[0] === 0 || ipv4[0] === 10 || ipv4[0] === 127 ||
    (ipv4[0] === 169 && ipv4[1] === 254) || (ipv4[0] === 172 && ipv4[1] >= 16 && ipv4[1] <= 31) ||
    (ipv4[0] === 192 && ipv4[1] === 168)
  );
  const privateIpv6 = host === "::" || host === "::1" || /^fe[89ab]/.test(host) || /^f[cd]/.test(host) || /^::ffff:(?:127|10)\./.test(host);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || host === "localhost" || host.endsWith(".localhost") || privateIpv4 || privateIpv6) return null;
  return `${JINA_READER_URL}${url.href}`;
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  if (!["search", "fetch"].includes(command) || !value) { console.error("Usage: pi-harness-web search <query> | fetch <url>"); process.exit(2); }
  try {
    try { process.loadEnvFile?.(); } catch {}
    const jinaUrl = command === "fetch" ? jinaReaderUrl(value) : null;
    if (command === "fetch" && !jinaUrl) throw new Error("Blocked or invalid fetch URL");
    let request = command === "search" ? searchRequest(value) : { url: value, headers: {}, provider: "direct URL" };
    let response = await fetch(request.url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { "user-agent": "pi-harness/1.0", ...request.headers } });
    if (!response.ok && request.provider === "Brave") {
      request = { url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(value)}`, headers: {}, provider: "DuckDuckGo HTML (fallback)" };
      response = await fetch(request.url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { "user-agent": "pi-harness/1.0" } });
    }
    const directStatus = response.status;
    let body = response.ok ? await cappedBody(response) : "";
    if (jinaUrl && request.provider === "direct URL" && (!response.ok || needsJinaFallback(response, body))) {
      const fallback = await fetch(jinaUrl, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { "user-agent": "pi-harness/1.0", Accept: "text/markdown" } });
      if (fallback.ok) {
        request = { url: jinaUrl, headers: {}, provider: "Jina Reader (fallback)" };
        response = fallback;
        body = await cappedBody(response);
      } else if (!body) throw new Error(`HTTP ${directStatus}`);
    }
    if (!response.ok) throw new Error(`HTTP ${directStatus}`);
    const title = body.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() ?? body.match(/^Title:\s*(.+)$/m)?.[1]?.trim() ?? "";
    console.log(JSON.stringify({ query: command === "search" ? value : undefined, url: response.url, title, provider: request.provider, bytes: Buffer.byteLength(body), truncated: Buffer.byteLength(body) >= MAX_BYTES, body }, null, 2));
  } catch (error) { console.error(`pi-harness-web: ${error.message}`); process.exit(1); }
}
