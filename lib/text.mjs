export function truncateText(value, maxBytes) {
  const text = String(value ?? "");
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return { text, bytes, truncated: false };
  let clipped = text;
  while (Buffer.byteLength(clipped, "utf8") > maxBytes) clipped = clipped.slice(0, -1);
  return { text: `${clipped}\n...[truncated after ${maxBytes} bytes]`, bytes, truncated: true };
}
