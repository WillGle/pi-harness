import { appendFileSync } from "node:fs";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai";

const zeroUsage = () => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function messageFor(model, content, stopReason) {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: zeroUsage(),
    stopReason,
    timestamp: Date.now(),
  };
}

function toolCallStream(model, names) {
  const stream = new AssistantMessageEventStream();
  const partial = messageFor(model, [], "pending");
  stream.push({ type: "start", partial });
  for (const [index, name] of names.entries()) {
    const toolCall = { type: "toolCall", id: `fixture-call-${Date.now()}-${index}`, name, arguments: { value: "from-pi-model" } };
    partial.content.push(toolCall);
    stream.push({ type: "toolcall_start", contentIndex: index, partial });
    stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial });
  }
  partial.stopReason = "toolUse";
  stream.push({ type: "done", reason: "toolUse", message: partial });
  stream.end();
  return stream;
}

function textStream(model, text) {
  const stream = new AssistantMessageEventStream();
  const partial = messageFor(model, [], "pending");
  stream.push({ type: "start", partial });
  const content = { type: "text", text: "" };
  partial.content.push(content);
  stream.push({ type: "text_start", contentIndex: 0, partial });
  content.text = text;
  stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial });
  stream.push({ type: "text_end", contentIndex: 0, content: text, partial });
  partial.stopReason = "stop";
  stream.push({ type: "done", reason: "stop", message: partial });
  stream.end();
  return stream;
}

export default function piMcpTestProvider(pi) {
  const toolNames = JSON.parse(process.env.PI_HARNESS_TEST_TOOL_NAMES ?? "[]");
  const plan = JSON.parse(process.env.PI_HARNESS_TEST_PROVIDER_PLAN ?? '["tool", "text"]');
  const tracePath = process.env.PI_HARNESS_TEST_PROVIDER_TRACE;
  let calls = 0;

  pi.registerProvider("pi-harness-mcp-test", {
    name: "Pi Harness local MCP test provider",
    api: "openai-completions",
    apiKey: "test-only",
    baseUrl: "http://127.0.0.1:1",
    models: [{
      id: "fixture",
      name: "Pi Harness MCP Fixture",
      api: "openai-completions",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 512,
    }],
    streamSimple(model, context, options) {
      if (options?.signal?.aborted) throw new Error("Test provider request cancelled.");
      const action = plan[calls] ?? plan.at(-1) ?? "text";
      calls += 1;
      if (tracePath) {
        const roles = context.messages.map(message => message.role);
        appendFileSync(tracePath, `${JSON.stringify({ action, roles, toolNames })}\n`);
      }
      if (action === "tool") return toolCallStream(model, toolNames);
      const results = context.messages
        .filter(message => message.role === "toolResult")
        .flatMap(message => (message.content ?? []).filter(block => block.type === "text").map(block => block.text));
      return textStream(model, results.join("\n"));
    },
  });
}
