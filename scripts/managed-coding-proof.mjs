import {readFileSync,writeFileSync,mkdtempSync,cpSync,mkdirSync,chmodSync,existsSync} from 'node:fs';
import assert from 'node:assert/strict';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createAgentSession,DefaultResourceLoader,SessionManager,SettingsManager,ModelRuntime,getAgentDir} from '@earendil-works/pi-coding-agent';
import harness from '../extensions/pi-harness.ts';
import subagents from '../node_modules/@tintinweb/pi-subagents/dist/index.js';
import {contextTelemetry,deterministicContextEdits} from '../lib/context-economics.mjs';
import {readControlState} from '../lib/control-state-store.mjs';
import {assertSupportedPlatform} from '../lib/platform.mjs';
assertSupportedPlatform();
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const modelChoice=process.argv[2];
const ledgerPath=process.argv[3];
const autonomous=process.argv.includes('--autonomous');
if(!modelChoice?.includes('/')||!ledgerPath)throw Error('Usage: node --experimental-strip-types scripts/managed-coding-proof.mjs provider/model /tmp/budget-ledger.json [--benchmark] [--autonomous]');
const runtime=await ModelRuntime.create();
const sourceAgentDir=getAgentDir();
// User-authorized override applies only to this disposable session.
const split=modelChoice.indexOf('/');
const model=runtime.getModel(modelChoice.slice(0,split),modelChoice.slice(split+1));
if(!model) throw Error('Active configured model unavailable; no fallback permitted');
const provider=model.provider,modelId=model.id;
const rates=[model.cost,...(model.cost?.tiers??[])];
const maximumInput=Math.max(...rates.flatMap(rate=>[rate.input,rate.cacheRead,rate.cacheWrite??0]));
const maximumOutput=Math.max(...rates.map(rate=>rate.output));
// Codex's adapter does not send max_output_tokens; reserve its full advertised output.
const initialCeiling=(model.contextWindow*maximumInput+model.maxTokens*maximumOutput)/1e6;
process.stdout.write(JSON.stringify({event:'live_preflight',model:provider+'/'+modelId,context_window:model.contextWindow,reservation_ceiling:initialCeiling,budget:1,provider_reported_cost:null})+'\n');
if(!Number.isFinite(initialCeiling)||initialCeiling>1)throw Error('Unchanged Pi model exceeds the conservative $1 reservation cap; no provider request sent');
let calls=0;
const usages=[];
const responses=[];
const metric=value=>Number.isFinite(value)&&value>=0?value:null;
const usageSample=usage=>({input:metric(usage?.input),output:metric(usage?.output),cacheRead:metric(usage?.cacheRead),cacheWrite:metric(usage?.cacheWrite),totalTokens:metric(usage?.totalTokens),cost:{input:metric(usage?.cost?.input),output:metric(usage?.cost?.output),cacheRead:metric(usage?.cost?.cacheRead),cacheWrite:metric(usage?.cost?.cacheWrite),total:metric(usage?.cost?.total)}});
const cacheHitRatio=usage=>usage&&[usage.input,usage.cacheRead,usage.cacheWrite].every(Number.isFinite)&&usage.input+usage.cacheRead+usage.cacheWrite>0?usage.cacheRead/(usage.input+usage.cacheRead+usage.cacheWrite):null;
const ledger=JSON.parse(readFileSync(ledgerPath,'utf8'));
const saveBudget=()=>writeFileSync(ledgerPath,JSON.stringify(ledger)+'\n');
const guarded=new Proxy(runtime,{get(target,key){
 if(['stream','complete','completeSimple','streamDeferred','fetchDeferred'].includes(key))return ()=>{throw Error('Unreserved model request path rejected');};
 if(key==='streamSimple') return (requested,context,options={})=>{
   if(requested.provider!==provider||requested.id!==modelId) throw Error('Live proof cannot change provider/model');
   const cost=requested.cost;
   if(!cost||!['input','output','cacheRead','cacheWrite'].every(k=>Number.isFinite(cost[k])&&cost[k]>=0)) throw Error('Pricing unavailable; fail closed before request');
   const output=2048;
   // Reserve the full advertised window and output, not the requested output cap.
   const ceiling=initialCeiling;
   if(!Number.isFinite(ceiling)||ceiling<=0||ledger.spent_upper+ledger.reserved+ceiling>ledger.limit) throw Error('Aggregate $1 reservation budget exhausted');
   ledger.reserved+=ceiling;ledger.requests++;saveBudget();
   calls++;
   process.stdout.write(JSON.stringify({event:'request_reserved',call:calls,model:provider+'/'+modelId,aggregate_spent_upper:ledger.spent_upper,aggregate_reserved:ledger.reserved,limit:ledger.limit})+'\n');
   const stream=target.streamSimple(requested,context,{...options,maxTokens:output,maxRetries:0});
   void stream.result().then(message=>{
     const usage=message.usage,sample=usageSample(usage);
     const validUsage=usage&&['input','output','cacheRead','cacheWrite'].every(k=>Number.isFinite(usage[k])&&usage[k]>=0);
     const reportedTokens=validUsage?usage.input+usage.output+usage.cacheRead+usage.cacheWrite:0;
     const responseText=message.content.filter(block=>block.type==='text').map(block=>block.text).join('').trim();
     const usageAvailable=[sample.input,sample.output,sample.cacheRead,sample.cacheWrite].some(value=>value!==null);
     responses.push({stop_reason:message.stopReason,response_ok:message.stopReason==='stop'&&responseText==='OK',usage_available:usageAvailable,usage:sample});
     usages.push(sample);
     if(!validUsage) {ledger.spent_upper+=ceiling;ledger.reserved-=ceiling;saveBudget();return;}
     if(reportedTokens===0) {ledger.spent_upper+=ceiling;ledger.reserved-=ceiling;saveBudget();return;}
     const upper=(usage.input+usage.cacheRead+usage.cacheWrite)*maximumInput/1e6+usage.output*maximumOutput/1e6;
     ledger.spent_upper+=upper;ledger.reserved-=ceiling;saveBudget();
   });
   return stream;
 };
 const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
}});
const sandbox=mkdtempSync('/tmp/pi-managed-proof-');
const agentDir=join(sandbox,'agent'),repo=join(sandbox,'repo');
mkdirSync(agentDir,{mode:0o700});chmodSync(agentDir,0o700);mkdirSync(repo);mkdirSync(join(repo,'.pi'));
for(const name of ['auth.json','models.json','models-store.json','settings.json']){
 const source=join(sourceAgentDir,name),destination=join(agentDir,name);
 if(existsSync(source)){cpSync(source,destination);chmodSync(destination,0o600);}
}
cpSync(join(root,'.pi/agents'),join(repo,'.pi/agents'),{recursive:true});
cpSync(join(root,'.pi/subagents.json'),join(repo,'.pi/subagents.json'));
process.env.PI_CODING_AGENT_DIR=agentDir;
process.env.PI_HARNESS_EVIDENCE_DIR=join(sandbox,'evidence');
process.env.PI_HARNESS_CONTROL_DIR=join(sandbox,'control');
const git=(...args)=>{const r=spawnSync('git',args,{cwd:repo,encoding:'utf8'});if(r.status)throw Error('Disposable Git setup failed');return r.stdout.trim();};
git('init','-q');git('config','user.name','Pi live proof');git('config','user.email','proof@example.invalid');git('add','.pi');git('commit','-qm','Initialize disposable managed proof');
process.chdir(repo);
const tools=new Map(),commands=new Map(),commanderQueue=[],commanderToolCalls=[];let ctx,tracingCommander=false,commanderRunReport;
const settings=SettingsManager.inMemory({defaultProvider:provider,defaultModel:modelId,compaction:{enabled:true},cacheWarming:'off'});
const loader=new DefaultResourceLoader({cwd:repo,agentDir,settingsManager:settings,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,extensionFactories:[{name:'subagents',factory:subagents},{name:'harness',factory:pi=>{
 const capture=new Proxy(pi,{get(target,key){if(key==='registerCommand')return (name,command)=>{commands.set(name,command);target.registerCommand(name,command);};if(key==='sendUserMessage')return text=>commanderQueue.push(text);if(key==='registerTool')return tool=>{const execute=tool.execute;const tracked={...tool,execute:async(...args)=>{const result=await execute(...args);if(tracingCommander){commanderToolCalls.push(tool.name);if(tool.name==='pi_harness_run_operation'){const text=result?.content?.find(item=>item.type==='text')?.text;if(text)commanderRunReport=JSON.parse(text);}}return result;}};tools.set(tool.name,tracked);target.registerTool(tracked);};return target[key];}});
 harness(capture);pi.on('session_start',(_event,context)=>{ctx=context;});
}}]});
await loader.reload();
const {session,extensionsResult}=await createAgentSession({cwd:repo,agentDir,modelRuntime:guarded,model,thinkingLevel:'off',settingsManager:settings,resourceLoader:loader,sessionManager:SessionManager.inMemory(repo)});
if(extensionsResult.errors.length)throw Error('Disposable extensions failed to load');
await session.bindExtensions({mode:'rpc'});
const manager=globalThis[Symbol.for('pi-subagents:manager')];
if(!manager)throw Error('Actual package manager not registered');
const run=async(name,input)=>{
 const reply=await tools.get(name).execute('proof-'+name,input,new AbortController().signal,undefined,ctx);
 return JSON.parse(reply.content[0].text);
};
const timeout=setTimeout(()=>session.abort(),240000);
try {
 const operationId=autonomous?'O-LIVE-AUTONOMOUS':'O-LIVE',taskId=`T-${autonomous?'O-LIVE-AUTONOMOUS':'O-LIVE'}-01`;
 if(autonomous){
   await commands.get('goal').handler('Live autonomous Commander proof: complete one managed coding Operation, then leave the Mission active for independent review.',ctx);
   commanderQueue.length=0;
   tracingCommander=true;
   try{await session.prompt(`The active Mission requires one autonomous managed coding proof. Create a planning Operation with operation_id ${operationId}, objective "In one Worker Task and its isolated worktree, create add.mjs exporting add(a,b) and add.test.mjs using node:test to assert add(2,3) equals 5. Limit the Task Acceptance Criterion to these file contents as shown in the Worker diff; do not require evidence that a test command ran. Do not split implementation and testing across dependent Tasks because accepted Worker branches are not integrated into later Task worktrees. Leave changes uncommitted. Do not merge or modify the parent repository.", constraints ["One Worker Task must create both files in the same task worktree. Acceptance Criteria must be verifiable from the selected diff Evidence."], and allowed_policy_ids ["worker-write"]. Do not provide required_task_ids, task_intents, task_specs, Dependencies, commands, permissions, or TaskOrder IDs. Then call pi_harness_run_operation for ${operationId}. The Coordinator must return plan_tasks with exactly one worker Task and let Harness materialize it. Do not use pi_harness_coordinate. Do not edit files or run git commands in the parent. Operation completion does not complete the Mission. Do not call pi_harness_goal; leave the Mission active.`);}finally{tracingCommander=false;}
   assert.ok(commanderToolCalls.includes('pi_harness_operation'),'The live Commander did not register an Operation.');
   assert.ok(commanderToolCalls.includes('pi_harness_run_operation'),'The live Commander did not start the Harness Coordinator.');
   assert.ok(!commanderToolCalls.includes('pi_harness_coordinate'),'The live Commander used disabled direct dispatch.');
 }else{
   await commands.get('goal').handler('Prove a managed coding Operation without auto-integrating its branch.',ctx);
   await run('pi_harness_operation',{action:'create',operation_id:operationId,objective:'In one Worker Task and its isolated worktree, create add.mjs exporting add(a,b) and add.test.mjs using node:test to assert add(2,3) equals 5. Limit the Task Acceptance Criterion to these file contents as shown in the Worker diff; do not require evidence that a test command ran. Do not split implementation and testing across dependent Tasks because accepted Worker branches are not integrated into later Task worktrees. Leave changes uncommitted. Do not merge or touch the original repository.',constraints:['One Worker Task must create both files in the same task worktree. Acceptance Criteria must be verifiable from the selected diff Evidence.'],allowed_policy_ids:['worker-write']});
 }
 const report=autonomous?commanderRunReport:await run('pi_harness_run_operation',{operation_id:operationId});
 assert.ok(report,'The Operation did not return a bounded OperationReport.');
 if(report.status!=='complete')process.stdout.write(JSON.stringify({event:'operation_blocked',report,commander_tool_calls:commanderToolCalls,model_requests:calls,aggregate_budget:ledger,usage:usages})+'\n');
 const mission=session.sessionManager.getEntries().filter(e=>e.customType==='pi-harness-goal-state').at(-1)?.data;
 assert.equal(mission.status,'active','Operation completion is not Mission completion');
 const state=session.sessionManager.getEntries().filter(e=>e.customType==='pi-harness-task-graph-state').at(-1)?.data;
 assert.equal(report.status,'complete');
 const accepted=state.operations[operationId].task_results[taskId];
 assert.equal(accepted.verification_status,'verified');
 assert.equal(state.task_graphs[operationId].nodes[taskId].scheduler_status,'accepted');
 assert.ok(accepted.evidence_refs.length);
 const controlBefore=readControlState(repo);
 const durableMission=controlBefore?.missions?.[mission.mission_id],durableOperation=controlBefore?.operations?.[operationId],durableNode=controlBefore?.task_graphs?.[operationId]?.nodes?.[taskId];
 const durableAttemptCount=Object.values(controlBefore?.attempt_ledger??{}).filter(attempt=>attempt.task_id===taskId).length;
 assert.equal(durableMission?.status,'active');assert.equal(durableOperation?.status,'complete');assert.equal(durableNode?.scheduler_status,'accepted');
 assert.equal(durableOperation?.task_results?.[taskId]?.verification_status,'verified');assert.equal(durableAttemptCount,1);
 const transitions=session.sessionManager.getEntries().filter(e=>e.customType==='pi-harness-task-graph-state').map(e=>e.data.task_graphs[operationId]?.nodes[taskId]);
 assert.ok(transitions.some(node=>node?.scheduler_status==='running'));
 assert.ok(transitions.some(node=>node?.verification_status==='verifying'));
 assert.ok(transitions.some(node=>node?.scheduler_status==='result_available'));
 assert.ok(transitions.some(node=>node?.scheduler_status==='accepted'));
 assert.ok(ledger.spent_upper+ledger.reserved<=1);
 assert.deepEqual(report.accepted_task_ids,[taskId]);
 assert.equal(git('rev-list','--count','HEAD'),'1','parent branch never integrates Worker commit');
 assert.equal(git('status','--porcelain'),'','parent worktree remains unchanged');
 const branch=accepted.artifact_refs.find(ref=>ref.startsWith('pi-agent-'));
 assert.ok(git('show',branch+':add.mjs').includes('add'));
 assert.ok(git('show',branch+':add.test.mjs').includes('assert'));
 const controlSummary={mission_status:durableMission.status,operation_status:durableOperation.status,task_status:durableNode.scheduler_status,verification_status:durableOperation.task_results[taskId].verification_status,attempt_count:durableAttemptCount};
 const proof={report,mission_status:mission.status,control_state:controlSummary,commander_driver:autonomous?'Autonomous live Pi SDK Commander turn; the Coordinator and Worker use live model turns':'Pi SDK command/tool boundary; Coordinator and Worker use live model',commander_tool_calls:commanderToolCalls,accepted_status:accepted.verification_status,semantic_review_status:accepted.semantic_verification?.status??'not_requested',evidence_count:accepted.evidence_refs.length,artifact_branch:branch,transitions:transitions.map(node=>({scheduler_status:node?.scheduler_status,verification_status:node?.verification_status})),usage:usages,aggregate_budget:ledger,provider_reported_cost:null};
 writeFileSync(join(sandbox,'proof.json'),JSON.stringify(proof,null,2)+'\n');
 process.stdout.write(JSON.stringify({event:'proof_report',sandbox,operation_status:report.status,mission_status:mission.status,accepted_status:accepted.verification_status,semantic_review_status:accepted.semantic_verification?.status??'not_requested',evidence_count:accepted.evidence_refs.length,artifact_branch:branch,calls,aggregate_budget:ledger,usage:usages,provider_reported_cost:null})+'\n');
 if(process.argv.includes('--benchmark')) {
   // The workload uses current managed Operation representations. Each blocked
   // report becomes eligible only when the later complete OperationReport exists.
   const benchmarkOperation=state.operations[operationId],benchmarkStart=Date.now();
   // The fixture needs Pi's complete AssistantMessage envelope; zero usage is only a schema placeholder and is excluded from provider samples.
   const appendBenchmarkCall=(id,timestamp)=>session.sessionManager.appendMessage({role:'assistant',content:[{type:'toolCall',id,name:'pi_harness_run_operation',arguments:{operation_id:operationId}}],api:model.api,provider,model:modelId,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'toolUse',timestamp});
   for(let i=0;i<12;i++){
     const toolCallId=`benchmark-blocked-${i}`;
     appendBenchmarkCall(toolCallId,benchmarkStart+i*2);
     session.sessionManager.appendMessage({role:'toolResult',toolCallId,toolName:'pi_harness_run_operation',content:[{type:'text',text:JSON.stringify({version:1,mission_id:benchmarkOperation.mission_id,operation_id:operationId,status:'blocked',summary:'Obsolete blocked OperationReport. '.repeat(400),blocker:'The historical TaskOrder was blocked.'})}],isError:false,timestamp:benchmarkStart+i*2+1});
   }
   appendBenchmarkCall('benchmark-complete',benchmarkStart+24);
   session.sessionManager.appendMessage({role:'toolResult',toolCallId:'benchmark-complete',toolName:'pi_harness_run_operation',content:[{type:'text',text:JSON.stringify({version:1,mission_id:benchmarkOperation.mission_id,operation_id:operationId,status:'complete',accepted_task_ids:[taskId]})}],isError:false,timestamp:benchmarkStart+25});
   const beforeIndex=responses.length;
   await session.prompt('Benchmark: reply with exactly OK, no tools.');
   assert.equal(responses.length,beforeIndex+1);
   const beforeResponse=responses.at(-1),beforeUsage=beforeResponse.response_ok?beforeResponse.usage:null,beforeBytes=Buffer.byteLength(JSON.stringify(session.sessionManager.buildSessionProjection().messages));
   const beforeEntries=session.sessionManager.getEntries(),beforeTelemetry=contextTelemetry(beforeEntries),contextEditsBefore=beforeEntries.filter(entry=>entry.type==='context_edit').length;
   // Explicit idle safe boundary in the benchmark driver; production uses native drafts.
   assert.equal(session.isStreaming,false);
   const collected=deterministicContextEdits(session.sessionManager.buildSessionProjection().entries,{operations:state.operations,taskGraphs:state.task_graphs});
   for(const edit of collected.edits)session.sessionManager.appendContextEdit(edit.targetId,edit.replacement);
   const afterBytes=Buffer.byteLength(JSON.stringify(session.sessionManager.buildSessionProjection().messages));
   const afterIndex=responses.length;
   await session.prompt('Benchmark: reply with exactly OK, no tools.');
   assert.equal(responses.length,afterIndex+1);
   const afterResponse=responses.at(-1),afterUsage=afterResponse.response_ok?afterResponse.usage:null;
   const afterEntries=session.sessionManager.getEntries(),afterTelemetry=contextTelemetry(afterEntries),contextEditsAfter=afterEntries.filter(entry=>entry.type==='context_edit').length;
   assert.ok(afterBytes<beforeBytes);assert.equal(collected.edits.length,12);
   assert.equal(JSON.stringify(benchmarkOperation),JSON.stringify(session.sessionManager.getEntries().filter(e=>e.customType==='pi-harness-task-graph-state').at(-1).data.operations[operationId]));
   const controlAfter=readControlState(repo);
   assert.deepEqual(controlAfter,controlBefore,'ContextEdit GC must not alter durable Mission, Operation, Task, or Attempt state');
   const beforePromptTokens=beforeUsage&&[beforeUsage.input,beforeUsage.cacheRead,beforeUsage.cacheWrite].every(Number.isFinite)?beforeUsage.input+beforeUsage.cacheRead+beforeUsage.cacheWrite:null,afterPromptTokens=afterUsage&&[afterUsage.input,afterUsage.cacheRead,afterUsage.cacheWrite].every(Number.isFinite)?afterUsage.input+afterUsage.cacheRead+afterUsage.cacheWrite:null;
   const benchmark={workload:'12 synthetic prior blocked OperationReport tool-call/results plus one later complete OperationReport; same provider prompt before/after deterministic promotion GC',before_response:beforeResponse,after_response:afterResponse,before_usage:beforeUsage,after_usage:afterUsage,input_tokens_before:beforeUsage?.input??null,input_tokens_after:afterUsage?.input??null,cache_read_tokens_before:beforeUsage?.cacheRead??null,cache_read_tokens_after:afterUsage?.cacheRead??null,cache_write_tokens_before:beforeUsage?.cacheWrite??null,cache_write_tokens_after:afterUsage?.cacheWrite??null,cache_hit_ratio_before:cacheHitRatio(beforeUsage),cache_hit_ratio_after:cacheHitRatio(afterUsage),before_prompt_tokens:beforePromptTokens,after_prompt_tokens:afterPromptTokens,prompt_token_reduction:beforePromptTokens===null||afterPromptTokens===null?null:beforePromptTokens-afterPromptTokens,provider_prompt_tokens_reduced:beforePromptTokens===null||afterPromptTokens===null?null:afterPromptTokens<beforePromptTokens,runtime_catalog_cost_before:beforeUsage?.cost?.total??null,runtime_catalog_cost_after:afterUsage?.cost?.total??null,provider_reported_cost:null,before_context_bytes:beforeBytes,after_context_bytes:afterBytes,context_bytes_removed:beforeBytes-afterBytes,gc_bytes_removed:collected.bytesRemoved,context_edits:collected.edits.length,context_edit_count_before:contextEditsBefore,context_edit_count_after:contextEditsAfter,compaction_count_before:beforeTelemetry.compaction_count,compaction_count_after:afterTelemetry.compaction_count,control_state_preserved:true,control_state:controlSummary,aggregate_budget:ledger};
   writeFileSync(join(sandbox,'benchmark.json'),JSON.stringify(benchmark,null,2)+'\n');
   process.stdout.write(JSON.stringify({event:'benchmark',sandbox,...benchmark})+'\n');
 }
}finally{clearTimeout(timeout);await session.abort();await session.extensionRunner.emit({type:'session_shutdown'});session.dispose();}
