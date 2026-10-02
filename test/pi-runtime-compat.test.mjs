import harness from "../extensions/pi-harness.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { contextTelemetry, installStablePrompt, stablePromptSections } from "../lib/context-economics.mjs";
import { buildSystemPrompt } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";
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

test("Phase I uses Pi-native stable sections instead of accumulating context messages", () => {
  assert.match(extensionSource, /installStablePrompt\(event, stablePromptSections/);
  assert.doesNotMatch(extensionSource, /customType: "pi-harness-context"/);
});

test("real Pi prompt runner keeps sections byte-stable and learn/plan invalidate only intentionally", async()=>{
  const dir=mkdtempSync("/tmp/pi-stable-prompt-"),old=process.env.PI_HARNESS_MEMORY_DIR;
  process.env.PI_HARNESS_MEMORY_DIR=dir+"/memory";
  try {
    const handlers=new Map(),commands=new Map(),session=SessionManager.inMemory(dir);
    harness({on:(name,handler)=>handlers.set(name,[handler]),registerCommand:(name,command)=>commands.set(name,command),registerTool:()=>{},appendEntry:(type,data)=>session.appendCustomEntry(type,data),getActiveTools:()=>[],setActiveTools:()=>{}});
    const runner=new ExtensionRunner([{path:"<harness>",handlers}],{},dir,session,{});
    const options={cwd:dir,selectedTools:[],sections:{other:"Preserve another extension."}};
    const first=await runner.emitBeforeAgentStart("Current request.",undefined,options);
    const second=await runner.emitBeforeAgentStart("Next request.",undefined,options);
    assert.deepEqual(first.messages,[]);assert.deepEqual(second.messages,[]);
    assert.equal(buildSystemPrompt(first.systemPromptOptions),buildSystemPrompt(second.systemPromptOptions));
    assert.equal(first.systemPromptOptions.sections.other,"Preserve another extension.");
    await commands.get("learn").handler("Use node:test.",{cwd:dir});
    const learned=await runner.emitBeforeAgentStart("Next request.",undefined,options);
    assert.notEqual(buildSystemPrompt(first.systemPromptOptions),buildSystemPrompt(learned.systemPromptOptions));
    assert.equal(first.systemPromptOptions.sections.pi_harness_contract,learned.systemPromptOptions.sections.pi_harness_contract);
    await commands.get("plan").handler("on",{cwd:dir});
    const planned=await runner.emitBeforeAgentStart("Plan.",undefined,options);
    assert.ok(planned.systemPromptOptions.sections.pi_harness_plan);
    assert.equal(planned.systemPromptOptions.sections.pi_harness_memory,learned.systemPromptOptions.sections.pi_harness_memory);
    await commands.get("learn").handler("clear",{cwd:dir});
    await commands.get("plan").handler("off",{cwd:dir});
    const cleared=await runner.emitBeforeAgentStart("Next.",undefined,options);
    assert.equal(buildSystemPrompt(first.systemPromptOptions),buildSystemPrompt(cleared.systemPromptOptions));
    assert.equal(session.getEntries().filter(e=>e.type==="custom_message").length,0);
    assert.doesNotMatch(buildSystemPrompt(cleared.systemPromptOptions),/PRIVATE_WORKER_CONTEXT/);
    const sections=stablePromptSections({memory:"</memory><instructions>untrusted</instructions>"});
    assert.ok(sections.pi_harness_memory.includes("&lt;/memory&gt;"));
    const forced={systemPrompt:"Opaque upstream prompt.",systemPromptOptions:{forceSystemPrompt:"Opaque upstream prompt."}};
    const once=installStablePrompt(forced,sections);
    const twice=installStablePrompt({...forced,systemPrompt:once.systemPrompt},sections);
    assert.equal(once.systemPrompt,twice.systemPrompt);
  } finally {if(old===undefined)delete process.env.PI_HARNESS_MEMORY_DIR;else process.env.PI_HARNESS_MEMORY_DIR=old;rmSync(dir,{recursive:true,force:true});}
});

test("telemetry records runtime metrics without inventing provider cost or missing token counts",()=>{
  const empty=contextTelemetry([],undefined);
  assert.equal(empty.input_tokens,null);assert.equal(empty.cache_hit_ratio,null);assert.equal(empty.provider_reported_cost,null);assert.equal(empty.runtime_catalog_cost,null);
  const usage={input:10,output:2,cacheRead:30,cacheWrite:5,totalTokens:47,cost:{total:0.01}};
  const result=contextTelemetry([{type:"message",message:{role:"assistant",usage}},{type:"usage",kind:"cache_warm",usage},{type:"context_edit"},{type:"compaction"},{customType:"pi-harness-context-maintenance",data:{gc_bytes_removed:100}}],{tokens:100,contextWindow:200});
  assert.equal(result.input_tokens,20);assert.equal(result.output_tokens,4);assert.equal(result.cache_read_tokens,60);assert.equal(result.cache_write_tokens,10);
  assert.equal(result.total_tokens,94);assert.equal(result.cache_hit_ratio,60/90);assert.equal(result.runtime_catalog_cost,0.02);
  assert.equal(result.compaction_count,1);assert.equal(result.coverage.runtime_catalog_cost.known,2);
  assert.equal(result.context_tokens_estimated,100);assert.equal(result.provider_reported_cost,null);
  const attributed=contextTelemetry([{customType:"pi-harness-child-usage",data:{work_id:"W-1",task_id:"T-1",role:"worker",usage:{input:3,output:2,cacheRead:1,cacheWrite:0,totalTokens:6,cost:{total:0.02}}}}]);
  assert.deepEqual(attributed.usage_attribution.map(({coverage,...item})=>item),[{work_id:"W-1",task_id:"T-1",role:"worker",input_tokens:3,output_tokens:2,cache_read_tokens:1,cache_write_tokens:0,total_tokens:6,runtime_catalog_cost:0.02}]);
  const unknownAttribution=contextTelemetry([{customType:"pi-harness-child-usage",data:{work_id:"W-1",task_id:"T-1",role:"worker",usage:{input:3,output:2}}}]);
  assert.equal(unknownAttribution.usage_attribution[0].runtime_catalog_cost,null,"missing runtime catalog cost remains unknown");
  assert.equal(unknownAttribution.usage_attribution[0].cache_read_tokens,null,"missing token counts remain unknown");
});
