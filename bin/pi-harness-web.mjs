#!/usr/bin/env node
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

export const MAX_BYTES = 1_000_000;
export const TIMEOUT_MS = 10_000;
export const MAX_REDIRECTS = 5;
export const MIN_HTML_TEXT_BYTES = 500;
export const JINA_READER_URL = "https://r.jina.ai/";
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const PRIVATE_NETWORKS = new BlockList();
for (const [network, prefix, type] of [
  ["0.0.0.0", 8, "ipv4"], ["10.0.0.0", 8, "ipv4"], ["100.64.0.0", 10, "ipv4"], ["127.0.0.0", 8, "ipv4"],
  ["169.254.0.0", 16, "ipv4"], ["172.16.0.0", 12, "ipv4"], ["192.0.0.0", 24, "ipv4"], ["192.168.0.0", 16, "ipv4"],
  ["198.18.0.0", 15, "ipv4"], ["224.0.0.0", 4, "ipv4"], ["::", 128, "ipv6"], ["::1", 128, "ipv6"],
  ["fc00::", 7, "ipv6"], ["fe80::", 10, "ipv6"], ["ff00::", 8, "ipv6"],
]) PRIVATE_NETWORKS.addSubnet(network, prefix, type);
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
function privateIp(value) {
  const host = value.toLowerCase().replace(/^\[|\]$/g, "");
  const version = isIP(host);
  return version > 0 && PRIVATE_NETWORKS.check(host, version === 4 ? "ipv4" : "ipv6");
}
function validateUrlShape(value) {
  const url = new URL(value);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || host === "localhost" || host.endsWith(".localhost") || privateIp(host)) throw new Error("Blocked or invalid fetch URL");
  return { url, host };
}
export async function validateFetchUrl(value) {
  const { url, host } = validateUrlShape(value);
  if (isIP(host) === 0) {
    let addresses;
    try { addresses = await lookup(host, { all: true, verbatim: true }); } catch { throw new Error("Blocked or invalid fetch URL"); }
    if (!addresses.length || addresses.some((entry) => privateIp(entry.address))) throw new Error("Blocked or invalid fetch URL");
  }
  return url;
}
export async function safeFetch(value, init = {}, deadline = Date.now() + TIMEOUT_MS) {
  let url = new URL(value);
  let redirects = 0;
  for (;;) {
    url = await validateFetchUrl(url);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Fetch timed out");
    const response = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(remaining) });
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    const location = response.headers.get("location");
    try { await response.body?.cancel(); } catch {}
    if (!location) throw new Error("Invalid redirect");
    if (redirects >= MAX_REDIRECTS) throw new Error("Too many redirects");
    url = new URL(location, url);
    redirects += 1;
  }
}
export function jinaReaderUrl(value) {
  let url;
  try { ({ url } = validateUrlShape(value)); } catch { return null; }
  return `${JINA_READER_URL}${url.href}`;
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  if (!["search", "fetch"].includes(command) || !value) { console.error("Usage: pi-harness-web search <query> | fetch <url>"); process.exit(2); }
  try {
    try { process.loadEnvFile?.(); } catch {}
    const jinaUrl = command === "fetch" ? jinaReaderUrl(value) : null;
    if (command === "fetch" && !jinaUrl) throw new Error("Blocked or invalid fetch URL");
    let request = command === "search" ? searchRequest(value) : { url: value, headers: {}, provider: "direct URL" };
    const deadline = Date.now() + TIMEOUT_MS;
    let response = await safeFetch(request.url, { headers: { "user-agent": "pi-harness/1.0", ...request.headers } }, deadline);
    if (!response.ok && request.provider === "Brave") {
      request = { url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(value)}`, headers: {}, provider: "DuckDuckGo HTML (fallback)" };
      response = await safeFetch(request.url, { headers: { "user-agent": "pi-harness/1.0" } }, deadline);
    }
    const directStatus = response.status;
    let body = response.ok ? await cappedBody(response) : "";
    if (jinaUrl && request.provider === "direct URL" && (!response.ok || needsJinaFallback(response, body))) {
      const fallback = await safeFetch(jinaUrl, { headers: { "user-agent": "pi-harness/1.0", Accept: "text/markdown" } }, deadline);
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
