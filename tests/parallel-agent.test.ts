import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

const load = (file: string) => import(new URL('../dsh-entry/' + file, import.meta.url).href)
const { newParallelJob, generateParallelDesigns, parallelProgress } = await load('parallel-agent.mjs')
const { generateCanvasDesign } = await load('agent-host.mjs')
const { applyParallelFrames } = await load('agent-editor.mjs')
const { resolveParallelModels } = await load('agent-selection.mjs')
const plan = { count: 3, focus: 'layout', mode: 'collaborate', iterations: 1, requestId: '55555555-1111-4111-8111-555555555555' }
const snapshot = { sessionId: 'native', activePageId: 'p0', context: {} }
const frame = (name: string) => ({type:'frame', name, width:140, height:80,
  children:[{type:'text', name:'Label', content:name}]})

test('the actual canvas design pipeline runs separate parallel model streams then iterates on their previous frame', async () => {
  let active = 0, peak = 0, planner = 0
  const assignments: any[] = []
  const sessions = new Set()
  const model = { async *stream(call: any) {
    const input = JSON.parse(call.messages[0].content[0].text)
    let result
    if (call.system.startsWith('Coordinate a canvas')) {
      planner++
      result = { shared: 'Navy, 16px body, top nav', tasks: ['Inbox', 'Item details', 'Review']
        .map(name => ({name, scope:'Own the ' + name + ' flow'})) }
    } else {
      const assignment = input.canvas.parallelAssignment
      assignments.push(assignment)
      sessions.add(call.sessionId)
      active++; peak = Math.max(peak, active)
      await new Promise(r => setTimeout(r, 4 * (4 - assignment.agent)))
      active--
      result = {reply:'Draft', action:'create', frame:frame(assignment.board.name + '-' + assignment.round)}
    }
    yield {type:'text-delta', index:0, text:JSON.stringify(result)}
    yield {type:'finish', reason:{kind:'stop'}}
  } }
  const job = newParallelJob(plan, 'hash', snapshot, 'conversation')
  const route = {provider:'local', model:'design'}
  const designs = await generateParallelDesigns({plan, job, generate:generateCanvasDesign,
    models:[route,route,route], signal:new AbortController().signal,
    common:{llm:model, modelSelection:route, prompt:'Design the review flow', context:{}, history:[]} })
  assert.equal(planner, 1)
  assert.equal(peak, 3)
  assert.equal(sessions.size, 3)
  assert.deepEqual(designs.map((d: any) => d.frame.name), ['Inbox-0','Item details-0','Review-0','Inbox-1','Item details-1','Review-1'])
  assert.equal(parallelProgress(job).completed, 6)
  for (const task of assignments.slice(3)) {
    assert.equal(task.previousVersion.name, task.board.name + '-0')
    assert.equal(task.siblingBoards.length, 2)
    assert.equal(task.shared, 'Navy, 16px body, top nav')
  }
})

test('a retry reuses completed workers and records the real failed slot', async () => {
  const options = {...plan, mode:'variants', iterations:0}
  const job = newParallelJob(options, 'request', snapshot, 'c')
  const calls: number[] = []
  let fail = true
  const generate = async ({context}: any) => {
    const i = context.parallelAssignment.agent; calls.push(i)
    if (i === 2 && fail) throw Object.assign(new Error('offline'), {code:'model_failed'})
    return {reply:'done', action:'create', frame:frame('Option '+i)}
  }
  const input = {plan:options, job, generate, models:[], signal:new AbortController().signal, common:{context:{}}}
  await assert.rejects(generateParallelDesigns(input), {code:'model_failed'})
  assert.deepEqual(parallelProgress(job).slots.map((s: any) => s.status), ['done','failed','done'])
  fail = false
  assert.equal((await generateParallelDesigns(input)).length, 3)
  assert.deepEqual(calls,[1,2,3,2])
})

test('the batch uses one versioned native write with stable IDs, verifies lost acknowledgments and preserves manual edits on retry', async () => {
  let writes = 0, version = 3
  const original = {id:'existing', name:'Original', type:'frame', x:0, y:0, width:80, height:80}
  let document = {pages:[{id:'p0', children:[original]}]}
  let conflict = false
  const live = {id:'native', selection:async()=>({activePageId:'p0', selectedIds:[]}),
    read:async()=>({version, documentJson:JSON.stringify(document)}),
    async call(tool: string) { return tool === 'snapshot_layout' ? {value:{layout:[original]}} : undefined },
    async replaceDocument(json: string, expected: number) {
      if (conflict) throw Error('Native version conflict (409)')
      assert.equal(expected, version)
      document = JSON.parse(json); writes++; version++
      throw Error('Lost acknowledgment')
    },
  }
  const host = {withCompilerCanvas:(_: any, fn: (arg: typeof live)=>unknown) => fn(live)}
  const args = {snapshot, signal:new AbortController().signal, batchKey:'project / conversation / request'}
  const designs = [0,1].flatMap(round=>[1,2].map(index=>({index, round, frame:frame('Board')})))
  const result = await applyParallelFrames(host, designs, args)
  assert.equal(result.length, 4)
  assert.deepEqual(document.pages[0].children[0], original)
  const added = document.pages[0].children.slice(1) as any[]
  assert.ok(added[0].x < added[1].x && added[0].y < added[2].y)
  const ids = added.flatMap(n=>[n.id,n.children[0].id])
  assert.equal(new Set(ids).size, 8)
  added[0].name = 'Manual rename'
  const retry = await applyParallelFrames(host, designs, args)
  assert.equal(retry[0].name, 'Manual rename')
  assert.equal(writes, 1)
  conflict = true
  await assert.rejects(applyParallelFrames(host, designs, {...args,batchKey:'other request'}), {code:'canvas_changed'})
  assert.equal(document.pages[0].children.length, 5)
})

test('strict Remote plan limits count and rounds and rejects arbitrary endpoints; per-agent route verifies fallback effort', async () => {
  const wire = await readFile(new URL('../dsh-entry/agent-wire.js', import.meta.url), 'utf8')
  const descriptors = runInNewContext(wire + ';canvasAgentContribution().descriptors')
  const [spec] = descriptors.filter((s: any) => s.method === 'generateParallel')
  assert.deepEqual(Array.from(spec.parameters, (p: any) => p.wire),['workspaceId','prompt','selection','attachments','visualSelection','plan'])
  const schema = spec.parameters.at(-1).codec.create()
  assert.equal(schema.parse(plan).count,3)
  for (const delta of [{count:7},{count:0},{iterations:6},{iterations:-1},{requestId:'../bad'},{count:1,mode:'variants',models:[{provider:'a',model:'b',url:'x'}]}])
    assert.throws(() => schema.parse({...plan,...delta}))
  const ctx = {agentDefaultModel:{currentSelection:()=>({provider:'p',model:'m',reasoningEffort:'max'})},
    llm:{listProviders:()=>[{id:'p'}],listModels:async()=>[{id:'m'},{id:'other'}],resolveModelInfo:async()=>({reasoning:{efforts:[]}})}}
  assert.deepEqual(await resolveParallelModels(ctx,{count:2,models:[null,{provider:'p',model:'other'}]},null,new AbortController().signal),
    [{provider:'p',model:'m',reasoningEffort:'max'},{provider:'p',model:'other'}])
})
