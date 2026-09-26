import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ExtensionRunner, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const piEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const piRoot = dirname(dirname(piEntry));
const piPackage = JSON.parse(readFileSync(join(piRoot, "package.json"), "utf8"));
const extensionTypes = readFileSync(join(piRoot, "dist/core/extensions/types.d.ts"), "utf8");
const extensionRunnerTypes = readFileSync(join(piRoot, "dist/core/extensions/runner.d.ts"), "utf8");
const sessionTypes = readFileSync(join(piRoot, "dist/core/session-manager.d.ts"), "utf8");
const settingsTypes = readFileSync(join(piRoot, "dist/core/settings-manager.d.ts"), "utf8");
const systemPromptTypes = readFileSync(join(piRoot, "dist/core/system-prompt.d.ts"), "utf8");
const cacheWarmerTypes = readFileSync(join(piRoot, "dist/core/cache-warmer.d.ts"), "utf8");
const extensionSource = readFileSync(new URL("../extensions/pi-harness.ts", import.meta.url), "utf8");

function block(source, name) {
  const match = source.match(new RegExp(`export interface ${name}[^\\n]*\\{[\\s\\S]*?\\n\\}`));
  assert.ok(match, `Pi 0.87.1 declaration ${name} exists`);
  return match[0];
}

test("Pi 0.87.1 and pi-subagents 0.19.0 are the exact compatibility targets", () => {
  const harnessPackage = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(piPackage.version, "0.87.1");
  assert.equal(harnessPackage.peerDependencies["@earendil-works/pi-coding-agent"], "0.87.1");
  assert.equal(harnessPackage.dependencies["@tintinweb/pi-subagents"], "0.19.0");
});

test("Pi 0.87.1 exposes the inspected runtime boundary APIs", () => {
  assert.equal(typeof ExtensionRunner.prototype.emitBoundary, "function");
  assert.equal(typeof ExtensionRunner.prototype.emitContext, "function");
  assert.equal(typeof ExtensionRunner.prototype.emitBeforeAgentStart, "function");
  assert.equal(typeof ExtensionRunner.prototype.emitCacheWarmingDecision, "function");
  assert.equal(typeof SessionManager.prototype.appendContextEdit, "function");
  assert.equal(typeof SettingsManager.prototype.getCacheWarmingMode, "function");
  assert.equal(typeof SettingsManager.prototype.setCacheWarmingMode, "function");
});

test("Pi 0.87.1 context, stable-prompt, and settlement declarations have the inspected shapes", () => {
  assert.match(block(extensionTypes, "ContextEvent"), /messages: AgentMessage\[\]/);
  assert.match(block(extensionTypes, "ContextEventResult"), /messages\?: AgentMessage\[\]/);
  assert.match(extensionTypes, /`messages` holds the conversation without system messages[\s\S]*?it restores them/);
  assert.match(block(extensionTypes, "ContextWithSystemEvent"), /messages: AgentMessage\[\]/);
  assert.match(extensionTypes, /`messages` is the full transcript including system messages[\s\S]*?the handler owns the prompt and tool declarations/);
  assert.match(extensionTypes, /on\(event: "context_with_system", handler: ExtensionHandler<ContextWithSystemEvent, ContextEventResult>\): \(\) => void;/);
  assert.match(block(extensionTypes, "BeforeAgentStartEvent"), /readonly systemPrompt: string/);
  assert.match(block(extensionTypes, "BeforeAgentStartEvent"), /systemPromptOptions: NormalizedBuildSystemPromptOptions/);
  assert.match(extensionTypes, /Mutable prompt sections\. Later handlers observe mutations made by earlier handlers\./);
  assert.match(block(extensionTypes, "BeforeAgentStartEventResult"), /systemPrompt\?: string/);
  assert.match(extensionTypes, /Replace the complete system prompt for this turn\. Later handlers observe this exact override\./);
  assert.match(systemPromptTypes, /export type NormalizedBuildSystemPromptOptions = BuildSystemPromptOptions & \{[\s\S]*?selectedTools: string\[\]/);
  assert.match(block(extensionTypes, "BoundaryState"), /entries: SessionBoundaryDraft\[\]/);
  assert.match(block(extensionTypes, "BoundaryState"), /continue: boolean/);
  assert.match(block(extensionTypes, "BoundaryState"), /context: BoundaryContextPreview/);
  assert.match(block(extensionTypes, "BoundaryState"), /outcome: AgentActivityOutcome/);
  assert.match(block(extensionTypes, "BoundaryContextPreview"), /contextEntries: ProjectedSessionEntry\[\]/);
  assert.match(block(extensionTypes, "BoundaryContextPreview"), /contextMessages: AgentMessage\[\]/);
  assert.match(block(extensionTypes, "BoundaryContextPreview"), /llmMessages: Message\[\]/);
  assert.match(block(extensionTypes, "BoundaryContextPreview"), /pendingMessages: AgentMessage\[\]/);
  assert.match(block(extensionTypes, "BoundaryContextPreview"), /canContinue: boolean/);
  assert.match(block(extensionTypes, "BoundaryResult"), /entries\?: SessionBoundaryDraft\[\]/);
  assert.match(block(extensionTypes, "BoundaryResult"), /continue\?: boolean/);
  assert.match(block(extensionTypes, "AgentBeforeSettleEvent"), /extends BoundaryState[\s\S]*?type: "agent_before_settle"/);
  assert.match(extensionTypes, /on\(event: "agent_before_settle", handler: ExtensionHandler<AgentBeforeSettleEvent, AgentBeforeSettleEventResult>\): \(\) => void;/);
  assert.match(block(extensionTypes, "TurnEndEvent"), /extends BoundaryState/);
  assert.match(block(extensionTypes, "TurnEndEvent"), /messageEntryId: string/);
  assert.match(block(extensionTypes, "TurnEndEvent"), /toolResultEntryIds: string\[\]/);
  assert.match(extensionRunnerTypes, /emitBoundary\(baseEvent: BoundaryBaseEvent[\s\S]*?Promise<BoundaryDispatchResult>/);
});

test("Pi 0.87.1 context edits and cache-warming capability shapes are inspectable", () => {
  assert.match(block(sessionTypes, "ContextEditEntry"), /type: "context_edit"/);
  assert.match(block(sessionTypes, "ContextEditEntry"), /targetId: string/);
  assert.match(block(sessionTypes, "ContextEditEntry"), /replacement: \{\s*content: ContextEditableContent;\s*\} \| null/);
  assert.match(sessionTypes, /appendContextEdit\(targetId: string, replacement: ContextEditEntry\["replacement"\]\): string/);
  assert.match(block(cacheWarmerTypes, "CacheWarmingDecision"), /phase: "streaming" \| "idle"/);
  assert.match(block(cacheWarmerTypes, "CacheWarmingDecision"), /expectedSavings: number/);
  assert.match(block(cacheWarmerTypes, "CacheWarmingDecision"), /economicsAvailable: boolean/);
  assert.match(block(cacheWarmerTypes, "CacheWarmingDecisionEvent"), /Pick<CacheWarmingDecision, "warmCost" \| "missCost" \| "continuationProbability" \| "action">/);
  assert.match(block(cacheWarmerTypes, "CacheWarmingDecisionEventResult"), /action\?: CacheWarmingAction/);
  assert.match(settingsTypes, /CACHE_WARMING_MODES: readonly \["off", "streaming", "idle"\]/);
  assert.match(settingsTypes, /cacheWarming\?: CacheWarmingMode/);
  assert.match(settingsTypes, /getCacheWarmingMode\(\): CacheWarmingMode/);
  assert.match(settingsTypes, /setCacheWarmingMode\(mode: CacheWarmingMode\): void/);
  assert.match(block(sessionTypes, "UsageEntry"), /type: "usage"/);
  assert.match(block(sessionTypes, "UsageEntry"), /kind: string/);
  assert.match(block(sessionTypes, "UsageEntry"), /provider: string/);
  assert.match(block(sessionTypes, "UsageEntry"), /model: string/);
  assert.match(block(sessionTypes, "UsageEntry"), /usage: Usage/);
  assert.match(sessionTypes, /export type SessionEntry = [^;]*UsageEntry/);
});

test("Phase I.0 inspects new APIs without enabling them in Pi Harness", () => {
  assert.match(extensionSource, /pi\.on\?\.\("context"/);
  assert.match(extensionSource, /pi\.on\?\.\("before_agent_start"/);
  assert.doesNotMatch(extensionSource, /pi\.on\?\.\("(?:context_with_system|agent_before_settle|cache_warming_decision)"/);
  assert.doesNotMatch(extensionSource, /systemPromptOptions|forceSystemPrompt|cacheWarming|appendContextEdit|context_edit/);
});
