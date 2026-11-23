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

test('complete designs retain real icon layers and borders across normalization and revision', () => {
  const source = { type: 'frame', name: '设置', width: 180, height: 56,
    stroke: { fill: '#eee', thickness: 1 }, opacity: 0.95, clipContent: true,
    children: [{ name: '外观图标', type: 'icon', icon: 'palette', color: '#667788', width: 18, height: 18 }] }
  const frame = normalizeCanvasFrame(source)
  assert.equal(frame.children[0].type, 'icon_font')
  assert.equal(frame.children[0].iconFontFamily, 'lucide')
  assert.equal(frame.children[0].iconFontName, 'palette')
  assert.deepEqual(frame.stroke, { fill: [{ type: 'solid', color: '#eeeeee' }], thickness: 1 })
  assert.deepEqual(normalizeCanvasFrame(frame), frame)
  assert.throws(() => normalizeCanvasFrame({ ...source, children: [{ type: 'icon', icon: 'invalid-name' }] }), { code: 'invalid_design' })
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

test('Agent selection follows live IDs on the active page, including nested text after save', async () => {
  const brand = { id: 'brand', type: 'text', name: 'Product name', content: 'Before save' }
  const subtitle = { id: 'subtitle', type: 'text', name: 'Subtitle', content: [{ text: 'Status ' }, { text: 'ready' }] }
  const board = { id: 'frame', type: 'frame', name: 'Board', children: [brand, subtitle] }
  const doc = { pages: [
    { id: 'inactive', children: [{ id: 'other', type: 'text', name: 'Other page', content: 'Other project text' }] },
    { id: 'active', children: [board] },
  ] }
  let selectedIds = ['subtitle', 'brand', 'other']
  // get_selection can provide only IDs; its optional node summaries omit text.
  const selection = { activePageId: 'active', get selectedIds() { return selectedIds }, nodes: [{ id: 'brand', name: 'Stale name' }] }
  const live = {
    id: 'session', selection: async () => selection,
    read: async () => ({ documentJson: JSON.stringify(doc) }),
  }
  const host = { withCompilerCanvas: (_: unknown, work: (editor: typeof live) => unknown) => work(live) }
  brand.name = '产品名'
  brand.content = 'SmartFav'
  const read = async (options = {}) => (await readCanvasContext(host, options)).context.selection
  assert.deepEqual((await read()).map((node: { name: string; text: string }) => [node.name, node.text]),
    [['Subtitle', 'Status ready'], ['产品名', 'SmartFav']])
  selectedIds = []
  assert.deepEqual(await read(), [])
  const visualSelection = { sessionId: live.id, activePageId: 'active', selectedIds: ['brand'] }
  const visualResult = await read({ visualSelection })
  assert.equal(visualResult[0].text, 'SmartFav')
  await assert.rejects(read({ visualSelection: { ...visualSelection, sessionId: 'closed-editor' } }), { code: 'canvas_changed' })
  selectedIds = ['brand']
  assert.deepEqual(await read({ visualSelection: { ...visualSelection, selectedIds: [] } }), [])
  doc.pages[1].children = []
  assert.deepEqual(await read(), [])
})
