import assert from 'node:assert/strict'
import test from 'node:test'

const { readCanvasContext, applyCanvasFrame, normalizeCanvasFrame } = await import(new URL('../dsh-entry/agent-editor.mjs', import.meta.url).href)

interface Layer {
  id: string
  type: string
  name: string
  x?: number
  y?: number
  width?: number
  height?: number
  content?: string
  children?: Layer[]
}

test('canvas generation and revision preserve authored boards and respect a later manual edit', async () => {
  const originals: Layer[] = Array.from({ length: 8 }, (_, i) => ({
    id: `board-${i}`, name: `Existing board ${i}`, type: 'frame',
    x: (i % 4) * 800, y: Math.floor(i / 4) * 840, width: 768, height: 800,
    children: [{ id: `title-${i}`, type: 'text', name: 'Title', content: `Authored copy ${i}` }],
  }))
  const roots = structuredClone(originals)
  let selectedId = 'title-0'
  let changes = 0

  // Only the native RPC boundary is substituted. The exercised code chooses
  // the edit, target ID, placement, and receipt from fresh document snapshots.
  const live = {
    id: 'test-editor',
    read: async () => ({ documentJson: JSON.stringify({ children: roots }) }),
    selection: async () => ({ activePageId: '0', selectedIds: [selectedId], nodes: [] }),
    call: async (tool: string, args: { data: Layer; nodeId: string; node_id: string }) => {
      switch (tool) {
        case 'snapshot_layout': return { value: { layout: roots } }
        case 'set_selection': selectedId = args.node_id; return
        case 'insert_node':
          roots.push({ ...structuredClone(args.data), id: `generated-${++changes}` })
          return
        case 'replace_node': {
          const target = roots.findIndex(n => n.id === args.nodeId)
          assert.notEqual(target, -1)
          roots[target] = { ...structuredClone(args.data), id: `generated-${++changes}` }
          return
        }
        default: assert.fail(`Unexpected native operation ${tool}`)
      }
    },
  }
  const host = { withCompilerCanvas: (_options: unknown, work: (editor: typeof live) => unknown) => work(live) }
  const frame = {
    type: 'frame', name: 'Reading activity', width: 320, height: 224,
    children: [{ type: 'text', name: 'Heading', content: 'This week' }],
  }

  const first = await readCanvasContext(host, {})
  const created = await applyCanvasFrame(host, frame, { action: 'create', snapshot: first })
  assert.deepEqual(roots.slice(0, -1), originals)
  assert.equal(selectedId, created.id)
  const placed = roots.at(-1)!
  assert.deepEqual([placed.x, placed.y, placed.children?.[0].content], [0, -256, 'This week'])

  const next = await readCanvasContext(host, { previousFrame: created })
  const revisedFrame = { ...frame, children: [{ ...frame.children[0], content: 'Today' }] }
  const revised = await applyCanvasFrame(host, revisedFrame, { action: 'revise', snapshot: next, previousFrame: created })
  assert.deepEqual(roots.slice(0, -1), originals)
  assert.equal(roots.at(-1)?.children?.[0].content, 'Today')
  assert.equal(selectedId, revised.id)

  const pending = await readCanvasContext(host, { previousFrame: revised })
  roots.at(-1)!.children![0].content = 'Edited by hand while the agent was generating'
  const manual = structuredClone(roots)
  await assert.rejects(
    applyCanvasFrame(host, frame, { action: 'revise', snapshot: pending, previousFrame: revised }),
    { code: 'revision_conflict' },
  )
  assert.equal(changes, 2)
  assert.deepEqual(roots, manual)
})


test('normalizes common design values and pinpoints invalid nested fields before writing', () => {
  const card = normalizeCanvasFrame({
    type: 'FRAME', name: '阅读进度', width: '360px', height: '210', layout: 'column',
    padding: '12px 16px', justifyContent: 'space-between', fill: 'rgba(255, 255, 255, 0.8)',
    children: [{
      type: 'TEXT', name: 'Title', characters: '本周阅读', fontSize: '20px', fontWeight: 'SemiBold',
      lineHeight: '26px', width: 'hug', fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }],
    }],
  })
  assert.deepEqual([card.width, card.height, card.layout, card.padding, card.justifyContent, card.fill],
    [360, 210, 'vertical', [12, 16], 'space_between', [{ type: 'solid', color: '#ffffffcc' }]])
  assert.deepEqual(card.children[0], {
    type: 'text', name: 'Title', content: '本周阅读', fontSize: 20, fontWeight: 600, lineHeight: 1.3,
    width: 'fit_content', fill: [{ type: 'solid', color: '#000000' }],
  })
  assert.deepEqual(normalizeCanvasFrame(card), card)
  const invalid = { ...card, children: [{ ...card.children[0], fontWeight: 'unrecognized sample text' }] }
  assert.throws(() => normalizeCanvasFrame(invalid), {
    code: 'invalid_design', diagnostic: 'frame.children[0].fontWeight: expected a number between 1 and 1000',
  })
})

test('the canvas model and effort reach every generation attempt; implicit depth keeps provider defaults', async () => {
  const { generateCanvasDesign } = await import(new URL('../dsh-entry/agent-host.mjs', import.meta.url).href)
  type Route = { provider: string; model: string; reasoningEffort?: string }
  const dispatched: Route[] = []
  const defaultRoute = { provider: 'native', model: 'default', reasoningEffort: 'high' }
  const explicitRoute = { provider: 'project', model: 'reasoner', reasoningEffort: 'low' }
  let defaultReads = 0
  const agentDefaultModel = { currentSelection() { defaultReads++; return defaultRoute } }
  const llm = {
    async *stream(options: Route) {
      const { provider, model, reasoningEffort } = options
      dispatched.push({ provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) })
      const text = dispatched.length === 1 ? 'incomplete' : '{"reply":"ready"}'
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const input = { llm, agentDefaultModel, prompt: 'Identify the primary action.' }
  assert.deepEqual(await generateCanvasDesign({ ...input, modelSelection: explicitRoute }), { reply: 'ready' })
  assert.deepEqual(dispatched, [explicitRoute, explicitRoute])
  assert.equal(defaultReads, 0)
  const adaptive = { provider: 'project', model: 'standard' }
  await generateCanvasDesign({ ...input, modelSelection: adaptive })
  await generateCanvasDesign(input)
  assert.deepEqual(dispatched.slice(2), [adaptive, defaultRoute])
  assert.equal(defaultReads, 1)
})
