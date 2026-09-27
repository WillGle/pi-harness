import {readFileSync,writeFileSync,mkdtempSync,cpSync,mkdirSync} from 'node:fs';
import assert from 'node:assert/strict';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createAgentSession,DefaultResourceLoader,SessionManager,SettingsManager,ModelRuntime} from '@earendil-works/pi-coding-agent';
import harness from '../extensions/pi-harness.ts';
import subagents from '../node_modules/@tintinweb/pi-subagents/dist/index.js';
import {contextTelemetry,deterministicContextEdits,stablePromptSections} from '../lib/context-economics.mjs';
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const modelChoice=process.argv[2];
const ledgerPath=process.argv[3];
if(!modelChoice?.includes('/')||!ledgerPath)throw Error('Usage: node --experimental-strip-types scripts/managed-coding-proof.mjs provider/model /tmp/budget-ledger.json [--benchmark]');
const runtime=await ModelRuntime.create();
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
let reserved=0,calls=0;
const usages=[];
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
   reserved+=ceiling;calls++;
   process.stdout.write(JSON.stringify({event:'request_reserved',call:calls,model:provider+'/'+modelId,cumulative_reservations:reserved})+'\n');
   const stream=target.streamSimple(requested,context,{...options,maxTokens:output,maxRetries:0});
   void stream.result().then(message=>{
     const usage=message.usage;
     if(!usage||!['input','output','cacheRead','cacheWrite'].every(k=>Number.isFinite(usage[k])&&usage[k]>=0)) return;
     const upper=(usage.input+usage.cacheRead+usage.cacheWrite)*maximumInput/1e6+usage.output*maximumOutput/1e6;
     usages.push(usage);ledger.spent_upper+=upper;ledger.reserved-=ceiling;saveBudget();
   });
   return stream;
 };
 const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
}});
const sandbox=mkdtempSync('/tmp/pi-managed-proof-');
const agentDir=join(sandbox,'agent'),repo=join(sandbox,'repo');
mkdirSync(agentDir);mkdirSync(repo);mkdirSync(join(repo,'.pi'));
cpSync(join(root,'.pi/agents'),join(repo,'.pi/agents'),{recursive:true});
cpSync(join(root,'.pi/subagents.json'),join(repo,'.pi/subagents.json'));
process.env.PI_CODING_AGENT_DIR=agentDir;
process.env.PI_HARNESS_EVIDENCE_DIR=join(sandbox,'evidence');
const git=(...args)=>{const r=spawnSync('git',args,{cwd:repo,encoding:'utf8'});if(r.status)throw Error('Disposable Git setup failed');return r.stdout.trim();};
git('init','-q');git('config','user.name','Pi live proof');git('config','user.email','proof@example.invalid');git('add','.pi');git('commit','-qm','Initialize disposable managed proof');
const tools=new Map(),commands=new Map(),commanderQueue=[];let ctx;
const settings=SettingsManager.inMemory({defaultProvider:provider,defaultModel:modelId,compaction:{enabled:false},cacheWarming:'off'});
const loader=new DefaultResourceLoader({cwd:repo,agentDir,settingsManager:settings,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,extensionFactories:[{name:'subagents',factory:subagents},{name:'harness',factory:pi=>{
 const capture=new Proxy(pi,{get(target,key){if(key==='registerCommand')return (name,command)=>{commands.set(name,command);target.registerCommand(name,command);};if(key==='sendUserMessage')return text=>commanderQueue.push(text);if(key==='registerTool')return tool=>{tools.set(tool.name,tool);target.registerTool(tool);};return target[key];}});
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
 await commands.get('goal').handler('Prove a managed coding Operation without auto-integrating its branch.',ctx);
 const operationId='O-LIVE',taskId='T-LIVE';
 await run('pi_harness_operation',{action:'create',operation_id:operationId,objective:'Implement add(a,b) in add.mjs with a passing Node test, on a package-managed branch only. Accept the verified TaskResult to complete this Operation.',required_task_ids:[taskId],task_intents:{[taskId]:'Create add.mjs exporting add(a,b), and add.test.mjs using node:test to assert add(2,3) equals 5. Run node --test add.test.mjs. Leave changes uncommitted: the package owns the single atomic commit with Scope: and Reason: metadata. Do not merge or touch the original repository.'},task_specs:{[taskId]:{owner:'worker',permission:'write',verification:'node --test add.test.mjs',acceptance_criteria:['The Worker verification command passes.','The package-managed branch exists.','The Worker commit policy is valid.','The Worker produced exactly one commit.']}}});
 const report=await run('pi_harness_run_operation',{operation_id:operationId});
 const mission=session.sessionManager.getEntries().filter(e=>e.customType==='pi-harness-goal-state').at(-1)?.data;
 assert.equal(mission.status,'active','Operation completion is not Mission completion');
 const state=session.sessionManager.getEntries().filter(e=>e.customType==='pi-harness-task-graph-state').at(-1)?.data;
 assert.equal(report.status,'complete');
 const accepted=state.operations[operationId].task_results[taskId];
 assert.equal(accepted.verification_status,'verified');
 assert.equal(state.task_graphs[operationId].nodes[taskId].scheduler_status,'accepted');
 assert.ok(accepted.evidence_refs.length);
 const transitions=session.sessionManager.getEntries().filter(e=>e.customType==='pi-harness-task-graph-state').map(e=>e.data.task_graphs[operationId]?.nodes[taskId]);
 assert.ok(transitions.some(node=>node?.scheduler_status==='running'));
 assert.ok(transitions.some(node=>node?.verification_status==='verifying'));
 assert.ok(transitions.some(node=>node?.scheduler_status==='result_available'));
 assert.ok(transitions.some(node=>node?.scheduler_status==='accepted'));
 assert.ok(ledger.spent_upper+ledger.reserved<=1);
 assert.deepEqual(report.accepted_task_ids,[taskId]);
 assert.equal(git('rev-list','--count','HEAD'),'1','parent branch never integrates Worker commit');
 const branch=accepted.artifact_refs.find(ref=>ref.startsWith('pi-agent-'));
 assert.ok(git('show',branch+':add.mjs').includes('add'));
 assert.ok(git('show',branch+':add.test.mjs').includes('assert'));
 const proof={report,mission_status:mission.status,commander_driver:'Pi SDK command/tool boundary; Coordinator and Worker use live model',accepted,transitions:transitions.map(node=>({scheduler_status:node?.scheduler_status,verification_status:node?.verification_status})),usage:usages,aggregate_budget:ledger,provider_reported_cost:null};
 writeFileSync(join(sandbox,'proof.json'),JSON.stringify(proof,null,2)+'\n');
 process.stdout.write(JSON.stringify({event:'proof_report',sandbox,report,accepted: {verification_status:accepted.verification_status,evidence_refs:accepted.evidence_refs,branch},calls,cumulative_reservations:reserved,aggregate_budget:ledger,usage:usages,provider_reported_cost:null})+'\n');
 if(process.argv.includes('--benchmark')) {
   for(let i=0;i<12;i++) {
     session.sessionManager.appendMessage({role:'user',content:'Historical bounded request '+i,timestamp:Date.now()});
     session.sessionManager.appendCustomMessageEntry('pi-harness-context',stablePromptSections().pi_harness_contract,false);
   }
   const base=session.sessionManager.getEntries();
   const beforeIndex=usages.length;
   await session.prompt('Benchmark: reply with exactly OK, no tools.');
   assert.equal(usages.length,beforeIndex+1);
   const beforeUsage=usages.at(-1),beforeBytes=Buffer.byteLength(JSON.stringify(session.sessionManager.buildSessionProjection().messages));
   // Explicit idle safe boundary in the benchmark driver; production uses native drafts.
   assert.equal(session.isStreaming,false);
   const collected=deterministicContextEdits(session.sessionManager.buildSessionProjection().entries,{operations:state.operations,taskGraphs:state.task_graphs});
   for(const edit of collected.edits)session.sessionManager.appendContextEdit(edit.targetId,edit.replacement);
   const afterBytes=Buffer.byteLength(JSON.stringify(session.sessionManager.buildSessionProjection().messages));
   const afterIndex=usages.length;
   await session.prompt('Benchmark: reply with exactly OK, no tools.');
   assert.equal(usages.length,afterIndex+1);
   const afterUsage=usages.at(-1);
   assert.ok(afterUsage.input+afterUsage.cacheRead+afterUsage.cacheWrite<beforeUsage.input+beforeUsage.cacheRead+beforeUsage.cacheWrite);
   assert.ok(afterBytes<beforeBytes);assert.equal(collected.edits.length,12);
   assert.equal(JSON.stringify(state.operations),JSON.stringify(session.sessionManager.getEntries().filter(e=>e.customType==='pi-harness-task-graph-state').at(-1).data.operations));
   const benchmark={workload:'12 historical exact Harness contracts, same OK request before/after deterministic GC',before_usage:beforeUsage,after_usage:afterUsage,before_context_bytes:beforeBytes,after_context_bytes:afterBytes,gc_bytes_removed:collected.bytesRemoved,context_edits:collected.edits.length,compaction_count:contextTelemetry(session.sessionManager.getEntries()).compaction_count,provider_reported_cost:null,aggregate_budget:ledger};
   writeFileSync(join(sandbox,'benchmark.json'),JSON.stringify(benchmark,null,2)+'\n');
   process.stdout.write(JSON.stringify({event:'benchmark',sandbox,...benchmark})+'\n');
 }
}finally{clearTimeout(timeout);await session.abort();await session.extensionRunner.emit({type:'session_shutdown'});session.dispose();}
