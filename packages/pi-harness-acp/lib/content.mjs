import { readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_TEXT_BYTES = 512 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_MIME = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
]);

function isTextMime(mime = "") {
  return mime.startsWith("text/") || /(?:json|javascript|typescript|xml|yaml|toml|markdown)/i.test(mime);
}

function localPath(uri, cwd) {
  if (uri.startsWith("file:")) return fileURLToPath(uri);
  if (isAbsolute(uri)) return uri;
  if (!/^[a-z][a-z\d+.-]*:/i.test(uri)) return resolve(cwd, uri);
}

function readLocalResource(block, cwd) {
  const path = localPath(block.uri, cwd);
  if (!path) return { text: `[Resource: ${block.name ?? block.uri}] ${block.uri}` };

  const size = statSync(path).size;
  const mimeType = block.mimeType || IMAGE_MIME.get(extname(path).toLowerCase()) || "text/plain";
  if (mimeType.startsWith("image/")) {
    if (size > MAX_IMAGE_BYTES) throw new Error(`Image is too large: ${block.uri}`);
    return { image: { type: "image", data: readFileSync(path).toString("base64"), mimeType } };
  }
  if (!isTextMime(mimeType) && block.mimeType) return { text: `[File: ${block.name ?? path}] ${path}` };
  if (size > MAX_TEXT_BYTES) throw new Error(`Text file is too large: ${block.uri}`);
  return { text: `[File: ${block.name ?? path}]\n${readFileSync(path, "utf8")}` };
}

export function decodeAcpPrompt(prompt, cwd = process.cwd()) {
  if (typeof prompt === "string") return { message: prompt, images: [] };
  if (!Array.isArray(prompt)) return { message: "", images: [] };

  const text = [];
  const images = [];
  for (const block of prompt) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") text.push(block.text);
    else if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
      if (Buffer.byteLength(block.data, "base64") > MAX_IMAGE_BYTES) throw new Error("Image is too large");
      images.push({ type: "image", data: block.data, mimeType: block.mimeType });
    } else if (block.type === "resource_link" && typeof block.uri === "string") {
      const decoded = readLocalResource(block, cwd);
      if (decoded.text) text.push(decoded.text);
      if (decoded.image) images.push(decoded.image);
    } else if (block.type === "resource" && block.resource) {
      const resource = block.resource;
      if (typeof resource.text === "string") text.push(`[File: ${resource.uri ?? "embedded"}]\n${resource.text}`);
      else if (typeof resource.blob === "string" && resource.mimeType?.startsWith("image/")) {
        if (Buffer.byteLength(resource.blob, "base64") > MAX_IMAGE_BYTES) throw new Error("Image is too large");
        images.push({ type: "image", data: resource.blob, mimeType: resource.mimeType });
      } else if (typeof resource.blob === "string" && isTextMime(resource.mimeType)) {
        const data = Buffer.from(resource.blob, "base64");
        if (data.length > MAX_TEXT_BYTES) throw new Error(`Text file is too large: ${resource.uri ?? "embedded"}`);
        text.push(`[File: ${resource.uri ?? "embedded"}]\n${data.toString("utf8")}`);
      }
    }
  }

  return {
    message: text.join("\n\n") || (images.length ? "Please analyze the attached image(s)." : ""),
    images,
  };
}
