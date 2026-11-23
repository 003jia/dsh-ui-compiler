import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const load = (file: string) => import(new URL('../dsh-entry/' + file, import.meta.url).href)
const jobs = await load('parallel-agent.mjs')
const text = await readFile(new URL('../dsh-entry/agent-service.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(text, { compilerOptions:{ target:ts.ScriptTarget.ES2022,
  module:ts.ModuleKind.CommonJS,experimentalDecorators:true }}).outputText

// Run the real Remote service and job scheduler, holding only the provider and
// editor at controllable I/O boundaries so intermediate states are observable.
async function fixture(editExisting = false, failFirstWorkerOnce = false) {
  const requestId = randomUUID(), current = {id:'conversation',turns:[] as any[]}
  const writes: string[] = [], prompts: string[] = []
  const histories = new Map<string,string[]>()
  const waiting = Array.from({length:3},()=>Promise.withResolvers<void>())
  const release = Array.from({length:3},()=>Promise.withResolvers<void>())
  const extraStarted = Promise.withResolvers<void>(), extraRelease = Promise.withResolvers<void>()
  const snapshot = {sessionId:'live',activePageId:'page',context:{},boards:[{id:'a',name:'Inbox'},{id:'b',name:'Account'}]}
  let service: any
  const editor = {readCanvasContext:async()=>snapshot,
    prepareAgentWorkAreas:async(_:any,count:number)=>Array.from({length:count},(_,i)=>({index:i+1,x:i*300,y:0})),
    resolveAgentWorkTarget:async()=>({x:3,y:8}),
    applyParallelFrames:async(_:any,[design]:any[])=>{
      writes.push(design.frame.name)
      return [{index:design.index,round:0,boardId:'id-'+design.index,count:2,name:design.frame.name,x:design.index*300,y:0}]
    }}
  const generate = async (args:any) => {
    if (args.planCount) return {shared:'Shared theme',tasks:[{name:'Inbox',scope:'Incoming updates',...(editExisting ? {targetBoardId:'a'} : {})},
      {name:'Account',scope:'Profile settings',...(editExisting ? {targetBoardId:'b'} : {})}]}
    prompts.push(args.prompt)
    histories.set(args.prompt, Array.from(args.history, (row:any) => row.text))
    if (args.prompt === 'Edit then fail') {
      writes.push('partial edit')
      args.canvasTools.onReceipt({name:'uic_canvas_edit',status:'success',summary:'Changed label'})
      throw Object.assign(new Error('Lost model stream after tool write'), {code:'model_failed'})
    }
    if (args.context?.parallelAssignment?.board?.targetBoardId) {
      const boardId=args.context.parallelAssignment.board.targetBoardId
      const read=await args.canvasTools.execute('uic_canvas_read',{nodeId:boardId})
      const edit=await args.canvasTools.execute('uic_canvas_edit',{sessionId:'live',pageId:'page',version:read.version,operations:[{op:'update',id:boardId,name:'Edited'}]})
      assert.equal(edit.changed[0].id,boardId)
      const row={name:'uic_canvas_edit',status:'success',summary:'Updated'}
      args.canvasTools.onReceipt(row)
      return {reply:'Changed '+boardId,toolCalls:[row]}
    }
    if (args.requireFrame) {
      const {agent,board}=args.context.parallelAssignment
      waiting[agent].resolve()
      await release[agent].promise
      if (agent === 1 && failFirstWorkerOnce) {
        failFirstWorkerOnce = false
        throw Object.assign(new Error('Temporary model failure'), {code:'model_failed'})
      }
      return {reply:'Placed '+board.name,frame:{name:board.name}}
    }
    if (args.prompt==='Original') { waiting[0].resolve(); await release[0].promise }
    if (args.prompt==='First addition') { extraStarted.resolve(); await extraRelease.promise }
    const data = await args.canvasTools.execute('uic_canvas_read',{nodeId:'target'})
    args.canvasTools.onReceipt({name:'uic_canvas_read',status:'success',target:data.nodes[0].name})
    return {reply:'Reviewed '+args.prompt}
  }
  const mods:Record<string,any> = {
    'node:crypto':{randomUUID}, '@deepseek-ai/dsh-llm':{}, '@deepseek-ai/dsh-typert-protocol':{Remote:()=>{},TypertRemoteService:class {}},
    './task-plan.mjs':{taskPlanSpec:{name:'uic_update_plan'},updateTaskPlan:()=>{}}, './project-binding.mjs':{resolveProjectBinding:async()=>({sourcePath:'/project/board.op',ownerSessionId:'owner'})},
    './agent-wire.mjs':{canvasAgentContribution:()=>({})},'./pen-context.mjs':{},
    './agent-host.mjs':{generateCanvasDesign:generate,resolveCanvasAttachments:async()=>({manifest:[],penAssetIds:[]})},
    './agent-selection.mjs':{resolveCanvasSelection:async()=>({modelSelection:{provider:'local',model:'base'}}),resolveParallelModels:async()=>[{provider:'local',model:'one'},{provider:'local',model:'two'}]},
    './agent-editor.mjs':editor,'./parallel-agent.mjs':jobs,
    './conversations.mjs':{activeConversation:async()=>current,appendConversationTurn:async(_:any,turn:any)=>current.turns.push(turn)},
    './canvas-tools.mjs':{canvasToolSpecs:[{name:'uic_canvas_read'}],canvasDeletionRequested:()=>false,canvasIconReplacementRequested:()=>false,
      runCanvasTool:async(_:any,options:any,name:string,args:any)=>{
        if (name==='uic_canvas_edit') {
          assert.ok(options.scopeRootId)
          assert.equal(args.operations[0].id,options.scopeRootId)
          writes.push(options.scopeRootId)
          return {version:2,changed:[{id:options.scopeRootId,op:'update'}]}
        }
        return {version:1,nodes:[{name:'Target',id:'target'}]}
      }},
  }
  const exports:any={}
  runInNewContext(compiled,{exports,require:(key:string)=>{assert.ok(key in mods,key);return mods[key]},AbortController,AbortSignal,performance})
  exports.mountCanvasAgent({effect:()=>{},plugin:(C:any)=>service=new C(),get:()=>null,logger:{warn:()=>{}}},editor,'/project')
  return {service,current,writes,prompts,waiting,release,extraStarted,extraRelease,requestId,snapshot,histories}
}

for (const parallel of [false,true]) test('in-flight instructions execute once in '+(parallel?'parallel':'single')+' jobs and close atomically',async()=>{
  const f = await fixture()
  const run = parallel
    ? f.service.generateParallel('w','Original',{},[],null,{count:2,mode:'collaborate',focus:'layout',iterations:0,requestId:f.requestId})
    : f.service.generateWithTools('w','Original',{},[],null,f.requestId)
  await f.waiting[parallel?1:0].promise
  const first=randomUUID(), second=randomUUID()
  assert.equal((await f.service.appendInstruction('w',f.requestId,first,'First addition')).status,'queued')
  assert.equal((await f.service.appendInstruction('w',f.requestId,first,'First addition')).status,'queued')
  assert.equal((await f.service.appendInstruction('w',f.requestId,first,'different')).error,'invalid_request')
  if (parallel) {
    await f.waiting[2].promise
    const progress=await f.service.parallelProgress('w',f.requestId)
    assert.deepEqual(Array.from(progress.slots,(s:any)=>s.title),['Inbox','Account'])
    f.release[2].resolve()
    await new Promise(resolve=>setImmediate(resolve))
    const partial=await f.service.parallelProgress('w',f.requestId)
    assert.equal(partial.completed,1)
    assert.deepEqual(f.writes,['Account'])
    assert.equal(partial.slots[1].boardId,'id-2')
    assert.equal(partial.slots[0].status,'running')
    assert.equal(partial.slots[1].toolCalls[0].name,'uic_canvas_place')
    f.release[1].resolve()
  } else f.release[0].resolve()
  await f.extraStarted.promise
  assert.equal((await f.service.appendInstruction('w',f.requestId,second,'Another addition')).status,'queued')
  f.extraRelease.resolve()
  const done=await run
  assert.equal(done.historySaved,true)
  assert.ok(done.plan.elapsedMs>=0)
  assert.ok(done.plan.slots[0].model.model)
  assert.equal(done.plan.elapsedMs,(await f.service.parallelProgress('w',f.requestId)).elapsedMs)
  assert.deepEqual(Array.from(done.plan.additions,(a:any)=>a.status),['done','done'])
  assert.equal(done.plan.phase,'done')
  assert.equal(f.prompts.filter(s=>s==='First addition').length,1)
  assert.equal(f.current.turns.length,1)
  assert.ok(done.toolCalls.find((r:any)=>r.additionId===second && r.agentIndex===1))
  assert.equal((await f.service.appendInstruction('w',f.requestId,randomUUID(),'Late')).error,'closed')
  assert.equal((await f.service.appendInstruction('w',f.requestId,first,'First addition')).status,'done')
})

test('a scoped collaboration edits two existing boards with two actual agents and does not place replacements',async()=>{
  const f=await fixture(true)
  const result=await f.service.generateParallel('w','修改已有的两张画板',{},[],null,{count:2,mode:'collaborate',focus:'layout',iterations:0,requestId:f.requestId})
  assert.deepEqual(f.writes.sort(),['a','b'])
  assert.deepEqual(Array.from(result.plan.slots,(s:any)=>s.boardId),['a','b'])
  assert.equal(result.plan.completed,2)
  assert.ok(result.results.every((r:any)=>r.revised))
  assert.ok(result.toolCalls.every((r:any)=>r.name==='uic_canvas_edit'))
})

test('in-place collaboration cannot create boards to fill unused worker slots', async () => {
  for (const count of [0, 1]) {
    const f = await fixture()
    f.snapshot.boards.length = count
    f.release[1].resolve()
    f.release[2].resolve()
    const result = await f.service.generateParallel('w','只修改现有画板的标题，不要新建画板',{},[],null,
      {count:2,mode:'collaborate',focus:'layout',iterations:0,requestId:f.requestId})
    assert.equal(result.error,'parallel_edit_targets')
    assert.deepEqual(f.writes,[])
    assert.deepEqual(f.prompts,[])
  }
})

test('retrying a partial batch resumes an acknowledged addition that never started', async () => {
  const f = await fixture(false, true)
  const plan = {count:2,mode:'collaborate',focus:'layout',iterations:0,requestId:f.requestId}
  const start = () => f.service.generateParallel('w','Original',{},[],null,plan)
  const first = start()
  await Promise.all([f.waiting[1].promise, f.waiting[2].promise])
  const additionId = randomUUID()
  assert.equal((await f.service.appendInstruction('w',f.requestId,additionId,'Keep the label')).status,'queued')
  f.release[2].resolve()
  f.release[1].resolve()
  assert.equal((await first).error,'model_failed')
  const retried = await start()
  assert.equal(retried.plan.phase,'done')
  assert.equal(retried.plan.additions[0].status,'done')
  assert.equal(f.prompts.filter(prompt=>prompt==='Keep the label').length,1)
  assert.deepEqual(f.writes.sort(),['Account','Inbox'])
})

for (const parallel of [false,true]) test('only unstarted additions resume after a follow-up writes then fails in a '+(parallel?'parallel':'single')+' job', async () => {
  const f = await fixture()
  const start = () => parallel
    ? f.service.generateParallel('w','Original',{},[],null,{count:2,mode:'collaborate',focus:'layout',iterations:0,requestId:f.requestId})
    : f.service.generateWithTools('w','Original',{},[],null,f.requestId)
  const first = start()
  await f.waiting[parallel?1:0].promise
  for (const text of ['First addition','Edit then fail','Continue with earlier text']) {
    assert.equal((await f.service.appendInstruction('w',f.requestId,randomUUID(),text)).status,'queued')
  }
  for (const gate of f.release) gate.resolve()
  f.extraRelease.resolve()
  const stopped = await first
  assert.equal(stopped.error,'model_failed')
  assert.deepEqual(Array.from(stopped.plan.additions,(a:any)=>a.status),['done','failed','queued'])
  const resumed = await start()
  assert.equal(resumed.error,'partial_followup')
  assert.equal(resumed.plan.phase,'failed')
  assert.deepEqual(Array.from(resumed.plan.additions,(a:any)=>a.status),['done','failed','done'])
  assert.ok(f.histories.get('Continue with earlier text')?.includes('Reviewed First addition'))
  assert.equal(f.prompts.filter(text=>text==='First addition').length,1)
  assert.equal(f.writes.filter(x=>x==='partial edit').length,1)
  const calls = f.prompts.length
  assert.equal((await start()).error,'partial_followup')
  assert.equal(f.prompts.length,calls)
  const finalTurn = f.current.turns.at(-1)
  assert.equal(finalTurn.failed,true)
  assert.equal(finalTurn.batchId,f.requestId)
  const cold = await fixture()
  cold.current.turns.push(finalTurn)
  const replay = await cold.service.generateWithTools('w','Original',{},[],null,f.requestId)
  assert.equal(replay.error,'partial_followup')
  assert.equal(cold.prompts.length,0)
})

test('an interrupted base edit stays idempotent across a new host and reports the base write', async () => {
  const first = await fixture()
  const send = (service:any) => service.generateWithTools('w','Edit then fail',{},[],null,first.requestId)
  const interrupted = await send(first.service)
  assert.deepEqual(first.writes,['partial edit'])
  const saved = first.current.turns[0]
  assert.equal(saved.failed,true)
  const cold = await fixture()
  cold.current.turns.push(saved)
  const replay = await send(cold.service)
  assert.deepEqual(cold.writes,[])
  assert.equal(saved.batchId,first.requestId)
  assert.equal(interrupted.error,'partial_base')
  assert.equal(replay.error,'partial_base')
  assert.equal(replay.toolCalls[0].name,'uic_canvas_edit')
  assert.equal(cold.prompts.length,0)
})
