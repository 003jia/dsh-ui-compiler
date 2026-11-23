import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const composerSource = readFileSync(new URL('../dsh-entry/agent-composer.js', import.meta.url), 'utf8')
const client = readFileSync(new URL('../dsh-entry/client.js', import.meta.url), 'utf8')
const start = client.indexOf('    function formatReply(')
const end = client.indexOf('    async function closeCanvas()', start)
assert.ok(start >= 0 && end > start)
const generateSource = client.slice(start, end) + '\ngenerate'
const flush = () => new Promise<void>(resolve => setImmediate(resolve))
const json = (value: any) => JSON.parse(JSON.stringify(value))

// Execute the actual render functions, event handlers, effects, and transport adapter
// in memory. Only React hook storage, host refs, timers and the remote agent are substitutes.
function mount(initialTurns: any[] = [], locale = 'zh', preferences = new Map<string, string>(), workspaceId = 'w1') {
  let index = 0
  let nodes: any[] = []
  let focused: any
  const slots: any[] = []
  const effects: Array<() => void> = []
  const calls: Array<{ method: string, args: any[] }> = []
  const timers = new Map<number, () => Promise<void>>()
  let nextTimer = 0
  let visual: any = { sessionId: 's1', activePageId: 'p1', selectedIds: ['product'] }
  let workspace = 'w1'
  const pointers: any[] = []
  let respond: (method: string, args: any[]) => any = () => ({ ok: true, value: { reply: '完成了' } })
  const remote = new Proxy({}, {
    get(_target, method: string) {
      return (...args: any[]) => { calls.push({ method, args }); return respond(method, args) }
    },
  })
  const chat = { id: 'one' }
  const generate = runInNewContext(generateSource, {
    chat, workspaceId: 'w1', sessionId: 's1', selectedWorkspace: () => ({ workspaceId: workspace }),
    controller: { current: { readVisualSelection: async () => visual, updateAgentWork: (state: any) => pointers.push(json(state)) } }, getCanvasAgent: () => remote,
    labels: { agentOffline: '离线', busyAgent: '忙', canvas_changed: '画布已切换' },
    lastRequest: { current: null }, crypto: { randomUUID }, AbortController, AbortSignal,
    setTimeout(fn: () => Promise<void>) { timers.set(++nextTimer, fn); return nextTimer },
    clearTimeout(id: number) { timers.delete(id) },
  })
  function effect(fn: () => any, deps: any[]) {
    const place = index++
    const prior = slots[place]
    if (!prior || !deps || deps.some((item, i) => !Object.is(prior.deps[i], item))) {
      const slot = { deps, cleanup: undefined }
      slots[place] = slot
      effects.push(() => { prior?.cleanup?.(); slot.cleanup = fn() })
    }
  }
  const react = {
    useId() { return 'id-' + index++ },
    useRef(value: any) { const i = index++; return slots[i] ??= { current: value } },
    useState(initial: any) {
      const i = index++
      if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial
      return [slots[i], (value: any) => { slots[i] = typeof value === 'function' ? value(slots[i]) : value }]
    },
    useEffect: effect, useLayoutEffect: effect,
  }
  const jsx = (type: any, props: any) => ({ type, props })
  const primitive = new Proxy({ Button: 'button', observeComposition: () => ({ guards: () => false, dispose() {} }) }, {
    get(object, name) { return Reflect.get(object, name) ?? 'icon' },
  })
  const Composer = runInNewContext(composerSource + '\nCanvasAgentComposer', {
    react, react_jsx_runtime: { jsx, jsxs: jsx }, require: () => primitive, AbortController, crypto: { randomUUID },
    localStorage: { getItem: (key: string) => preferences.get(key) ?? null, setItem: (key: string, value: string) => preferences.set(key, value) },
  })
  const props = {
    active: true, project: { draft: '设计主页' }, workspaceId, conversationId: 'one', locale, initialTurns,
    loadModels: async () => ({ default: { provider: 'vendor', model: 'one' }, groups: [
      { id: 'vendor', name: '厂商', models: ['one', 'two'].map(id => ({
        id, name: id, reasoning: { defaultEffort: 'low', efforts: [{ id: 'high', name: 'High' }] },
      })) },
    ] }),
    onGenerate: generate, formatReply: (turn: any) => turn.reply,
    uploadFile: async (file: any) => ({ id: file.name, name: file.name, mimeType: file.type }),
  }
  function traverse(node: any) {
    if (Array.isArray(node)) return node.forEach(traverse)
    if (!node || typeof node !== 'object') return
    if (typeof node.type === 'function') return traverse(node.type(node.props))
    nodes.push(node)
    const ref = node.props.ref
    if (ref) ref.current ??= {
      style: {}, scrollHeight: 20, ownerDocument: {},
      focus() { focused = ref.current },
    }
    traverse(node.props.children)
  }
  function render() {
    index = 0
    nodes = []
    traverse(Composer(props))
    effects.splice(0).forEach(fn => fn())
  }
  function byLabel(label: string) {
    const match = nodes.find(n => n.props['aria-label'] === label)
    assert.ok(match, 'Missing control: ' + label)
    return match
  }
  const byType = (type: string) => nodes.find(n => n.type === type)
  const trigger = () => nodes.find(n => n.props.className === 'uic-run-trigger')
  const click = (label: string) => { byLabel(label).props.onClick(); render() }
  const change = (label: string, value: string) => { byLabel(label).props.onChange({ currentTarget: { value } }); render() }
  async function settle() { await flush(); render() }
  function submit() { byType('form').props.onSubmit({ preventDefault() {} }); render() }
  render()
  return {
    calls, chat, timers, pointers, submit, settle, render, byLabel, byType, click, change, trigger,
    find: (predicate: (n: any) => boolean) => nodes.find(predicate), focused: () => focused,
    settings() { trigger().props.onClick(); render() },
    setResponse(value: typeof respond) { respond = value },
    setVisual(value: any) { visual = value },
    setWorkspace(value: string) { workspace = value },
    edit(value: string) { byType('textarea').props.onChange({ target: { value } }); render() },
    async drop(name: string) {
      byType('form').props.onDrop({ preventDefault() {}, stopPropagation() {},
        dataTransfer: { files: [{ name, type: 'image/png', size: 12, lastModified: 1 }] } })
      await settle()
    },
  }
}

test('default run binds tools to the visual or fallback canvas context; keyboard disclosure restores focus', async () => {
  const ui = mount()
  await ui.settle()
  assert.equal(ui.trigger().props['aria-expanded'], false)
  ui.settings()
  const group = ui.byLabel('Agent 数量')
  assert.equal(group.props.role, 'group')
  assert.deepEqual(json(group.props.children.map((n: any) => n.props['aria-pressed'])), [true, false, false, false, false, false])
  assert.equal(ui.byLabel('分工协作').props['aria-pressed'], true)
  assert.equal(group.props.children[0].props.autoFocus, true)
  assert.equal(ui.byLabel('布局').props.disabled, true)
  const section = ui.byLabel('并行 Agent')
  assert.equal(section.props.id, ui.trigger().props['aria-controls'])
  section.props.onKeyDown({ key: 'Escape', stopPropagation() {} })
  ui.render()
  assert.equal(ui.focused(), ui.trigger().props.ref.current)
  ui.submit()
  await ui.settle()
  assert.equal(ui.calls[0].method, 'generateWithTools')
  assert.deepEqual(json(ui.calls[0].args.slice(0, 5)), ['w1', '设计主页', {}, [], { sessionId: 's1', activePageId: 'p1', selectedIds: ['product'] }])
  ui.edit('无选区信息')
  ui.setVisual(null)
  ui.submit()
  await ui.settle()
  assert.equal(ui.calls[1].method, 'generateWithTools')
  assert.deepEqual(json(ui.calls[1].args.slice(0, 4)), ['w1', '无选区信息', {}, []])
  assert.equal(ui.calls[1].args[4], null)
  assert.equal(ui.timers.size, 0)
})

test('variant model, effort, inherited routes, iterations, focus and board total match the actual host payload', async () => {
  const ui = mount()
  await ui.settle()
  ui.change('模型', '["vendor","one"]')
  ui.change('思考深度', 'high')
  await ui.drop('guide.png')
  ui.settings()
  ui.click('3 Agent')
  assert.equal(ui.byLabel('分工协作').props['aria-pressed'], true)
  ui.click('分别创建版本')
  ui.change('Agent 2 · 各 Agent 的模型', '["vendor","two"]')
  ui.change('逐一探索变体', '2')
  ui.click('风格')
  assert.equal(ui.find(n => n.props.className === 'uic-run-total').props.children, '本次将生成 9 张画板')
  ui.submit()
  await ui.settle()
  const { method, args } = ui.calls[0]
  assert.equal(method, 'generateParallel')
  assert.ok(args[6] instanceof AbortSignal)
  assert.deepEqual(json(args.slice(0, 4)), ['w1', '设计主页', { provider: 'vendor', model: 'one', reasoningEffort: 'high' },
    [{ id: 'guide.png', name: 'guide.png', mimeType: 'image/png' }]])
  const { requestId, ...options } = args[5]
  assert.match(requestId, /^[0-9a-f-]{36}$/u)
  assert.deepEqual(json(options), { count: 3, mode: 'variants', iterations: 2, focus: 'style',
    models: [null, { provider: 'vendor', model: 'two' }, null] })
  ui.edit('协作稿')
  ui.settings()
  ui.click('分工协作')
  assert.equal(ui.find(n => n.props.className === 'uic-run-models'), undefined)
  ui.submit()
  await ui.settle()
  assert.deepEqual(json(ui.calls[1].args[5].models), [])
  assert.equal(ui.calls[1].args[5].mode, 'collaborate')
  ui.edit('单人迭代')
  ui.settings()
  ui.click('1 Agent')
  ui.submit()
  await ui.settle()
  assert.equal(ui.calls[2].method, 'generateParallel')
  assert.equal(ui.calls[2].args[5].count, 1)
  assert.equal(ui.calls[2].args[5].iterations, 2)
})

test('retries reuse an ID only for the same conversation, page, session, selected nodes, and configuration', async () => {
  const ui = mount()
  await ui.settle()
  ui.settings()
  ui.click('2 Agent')
  ui.setResponse(() => ({ ok: true, value: { error: 'busy' } }))
  async function send() {
    ui.submit()
    await ui.settle()
    return ui.calls.at(-1)!.args[5].requestId
  }
  const first = await send()
  assert.equal(await send(), first)
  ui.setVisual({ sessionId: 's1', activePageId: 'p1', selectedIds: ['b', 'a'] })
  const otherSelection = await send()
  assert.notEqual(otherSelection, first)
  ui.setVisual({ sessionId: 's1', activePageId: 'p1', selectedIds: ['a', 'b'] })
  assert.equal(await send(), otherSelection)
  ui.setVisual({ sessionId: 's1', activePageId: 'p2', selectedIds: ['a', 'b'] })
  const otherPage = await send()
  assert.notEqual(otherPage, otherSelection)
  ui.setVisual({ sessionId: 's2', activePageId: 'p2', selectedIds: ['a', 'b'] })
  const otherSession = await send()
  assert.notEqual(otherSession, otherPage)
  ui.chat.id = 'another'
  const otherChat = await send()
  assert.notEqual(otherChat, otherSession)
  ui.settings()
  ui.click('3 Agent')
  const otherSettings = await send()
  assert.notEqual(otherSettings, otherChat)
  ui.setResponse(() => ({ ok: true, value: { reply: '完成' } }))
  assert.equal(await send(), otherSettings)
  ui.edit('设计主页')
  assert.notEqual(await send(), otherSettings)
  assert.equal(ui.timers.size, 0)
})

test('one pending batch routes progress, suppresses duplicate sends, and retains a newly dropped attachment and draft', async () => {
  const ui = mount()
  await ui.settle()
  ui.settings()
  ui.click('2 Agent')
  let resolve: (value: any) => void = () => {}
  ui.setResponse(method => method === 'parallelProgress'
    ? { ok: true, value: { phase: 'generating', completed: 1, total: 2 } }
    : new Promise(done => { resolve = done }))
  await ui.drop('before.png')
  ui.submit()
  ui.submit()
  await ui.settle()
  assert.deepEqual(ui.calls.map(c => c.method), ['generateParallel'])
  assert.equal(ui.trigger().props.disabled, true)
  assert.equal(ui.find(n => n.props.role === 'log').props['aria-live'], 'polite')
  const [timerId, callback] = [...ui.timers][0]
  ui.timers.delete(timerId)
  await callback()
  ui.render()
  assert.ok(ui.find(n => n.props.children === '正在生成画板 · 1 / 2 已完成'))
  assert.equal(ui.calls[1].args[1], ui.calls[0].args[5].requestId)
  await ui.drop('next.png')
  ui.edit('下一轮')
  resolve({ ok: true, value: { reply: '完成' } })
  await ui.settle()
  assert.equal(ui.timers.size, 0)
  assert.equal(ui.find(n => n.props.title === 'before.png'), undefined)
  assert.ok(ui.find(n => n.props.title === 'next.png'))
  assert.equal(ui.byType('textarea').props.value, '下一轮')
})

test('native stop aborts generation, suppresses stale progress and releases send without losing the prompt', async () => {
  const ui = mount()
  await ui.settle()
  ui.settings()
  ui.click('2 Agent')
  let finishPoll: (value: any) => void = () => {}
  ui.setResponse((method, args) => method === 'parallelProgress' ? new Promise(done => { finishPoll = done })
    : new Promise((_done, reject) => args.at(-1).addEventListener('abort', () => reject(new Error('aborted')), { once: true })))
  ui.submit()
  await ui.settle()
  const [id, refresh] = [...ui.timers][0]
  ui.timers.delete(id)
  const polling = refresh()
  ui.click('停止生成')
  await ui.settle()
  assert.equal(ui.calls[0].args[6].aborted, true)
  finishPoll({ ok: true, value: { phase: 'writing' } })
  await polling
  ui.render()
  assert.equal(ui.timers.size, 0)
  assert.equal(ui.byType('textarea').props.value, '设计主页')
  assert.equal(ui.find(n => n.props.role === 'alert'), undefined)
  assert.equal(ui.find(n => n.props.children === '正在把画板写入画布…'), undefined)
  assert.equal(ui.byLabel('发送给画布 Agent').props.disabled, false)
})

test('expandable tool receipts appear only for executed tools, including failed, prior and parallel turns', async () => {
  const successful = {name: 'uic_canvas_edit', status: 'success', target: '设置按钮', summary: '更新 1 个图层'}
  const failed = {name: 'uic_canvas_edit', status: 'error', target: '旧按钮', summary: '目标已变更'}
  const ui = mount()
  await ui.settle()
  const log = () => ui.find(n => n.props.className === 'uic-agent-tool-log')
  assert.equal(log(), undefined)
  ui.setResponse(() => ({ok: true, value: {error: 'canvas_changed', toolCalls: [failed]}}))
  ui.submit()
  await ui.settle()
  assert.equal(ui.byType('textarea').props.value, '设计主页')
  assert.equal(log().type, 'details')
  assert.equal(log().props.open, undefined)
  assert.equal(ui.find(n => n.type === 'summary' && n.props.children === '1 次工具调用 · 1 次失败').type, 'summary')
  assert.equal(ui.find(n => n.props.role === 'alert').props.children, '画布已切换')
  assert.equal(ui.find(n => n.type === 'strong' && n.props.title === 'uic_canvas_edit').props.children, '编辑画布')

  ui.setResponse(() => ({ok: true, value: {reply: '完成', toolCalls: [successful]}}))
  ui.settings()
  ui.click('2 Agent')
  ui.submit()
  await ui.settle()
  assert.equal(ui.calls.at(-1)?.method, 'generateParallel')
  assert.equal(ui.find(n => n.type === 'summary' && n.props.children === '1 次工具调用').type, 'summary')
  assert.equal(ui.find(n => n.type === 'small' && n.props.children === '更新 1 个图层').type, 'small')
  assert.equal(ui.byType('textarea').props.value, '')

  const reopened = mount([
    {prompt: 'legacy', reply: 'legacy reply'},
    {prompt: 'a', reply: 'drawn', toolCalls: [successful, {name: 'uic_canvas_read', status: 'success'}]},
    {prompt: 'b', reply: 'try again', toolCalls: [failed], failed: true},
  ], 'en')
  await reopened.settle()
  assert.ok(reopened.find(n => n.type === 'summary' && n.props.children === '2 tool calls'))
  assert.ok(reopened.find(n => n.type === 'summary' && n.props.children === '1 tool call · 1 failed'))
  assert.ok(reopened.find(n => n.props.role === 'alert' && n.props.children === 'try again'))
})

test('single-agent retries reuse the same tool request until the selection changes or the host acknowledges success', async () => {
  const ui = mount()
  await ui.settle()
  ui.setResponse(() => ({ ok: false }))
  const send = async () => {
    ui.submit()
    await ui.settle()
    const call = ui.calls.at(-1)!
    assert.equal(call.method, 'generateWithTools')
    assert.ok(call.args[6] instanceof AbortSignal)
    return call.args[5]
  }
  const first = await send()
  assert.match(first, /^[a-f0-9-]{36}$/u)
  assert.equal(await send(), first)
  ui.setVisual({sessionId: 's1', activePageId: 'p1', selectedIds: ['next']})
  ui.setResponse(() => ({ ok: true, value: { reply: '完成' } }))
  const next = await send()
  assert.notEqual(next, first)
  ui.edit('设计主页')
  assert.notEqual(await send(), next)
})

test('live plan, worker activity, actual tool groups and idempotent mid-run instructions use the same request', async () => {
  const ui = mount()
  await ui.settle()
  let finish: (result: any) => void = () => {}
  let attempts = 0
  const progress = {
    phase: 'generating', sessionId: 's1', pageId: 'p1',
    steps: [{title:'绘制控件', status:'running'}],
    slots: [{index:1, round:0, status:'writing', title:'工具栏', scope:'在顶部调整按钮', x:410, y:256,
      activeTool: {name:'uic_canvas_place', target:'工具栏'},
      toolCalls: [{name:'uic_canvas_read', status:'success', target:'按钮', summary:'找到图层'}]}],
    additions: [] as any[],
  }
  ui.setResponse((method, args) => {
    if (method === 'parallelProgress') return {ok:true, value:progress}
    if (method === 'appendInstruction') {
      if (++attempts === 1) throw Error('ack lost')
      progress.additions = [{id:args[2], text:args[3], status:'queued'}]
      return {ok:true, value:{ok:true, status:'queued'}}
    }
    return new Promise(resolve => { finish = resolve })
  })
  ui.submit()
  await ui.settle()
  assert.equal(ui.byType('textarea').props.value, '')
  const requestId = ui.calls[0].args[5]
  const [timerId, refresh] = [...ui.timers][0]
  ui.timers.delete(timerId)
  await refresh()
  ui.render()
  assert.equal(ui.find(n => n.props.className === 'uic-agent-plan').props.open, true)
  assert.ok(ui.find(n => n.props.children === '绘制控件'))
  assert.ok(ui.find(n => n.props.children === 'Agent 1 · 工具栏'))
  assert.ok(ui.find(n => n.props.children === '正在绘制'))
  assert.ok(ui.find(n => n.props.children === '绘制画板'))
  assert.equal(ui.pointers[0].requestId, requestId)
  assert.equal(ui.pointers[0].slots[0].x, 410)
  ui.edit('按钮改名为刷新')
  ui.submit()
  await ui.settle()
  assert.equal(ui.byType('textarea').props.value, '按钮改名为刷新')
  ui.submit()
  await ui.settle()
  const additions = ui.calls.filter(call => call.method === 'appendInstruction')
  assert.equal(additions.length, 2)
  assert.equal(additions[0].args[2], additions[1].args[2])
  assert.deepEqual(additions[1].args.slice(0, 2), ['w1', requestId])
  assert.equal(additions[1].args[3], '按钮改名为刷新')
  assert.equal(ui.byType('textarea').props.value, '')
  assert.ok(ui.find(n => n.props.children === '按钮改名为刷新'))
  finish({ok:true, value:{reply:'已应用', plan:{...progress, additions:progress.additions.map(x=>({...x,status:'done'}))}}})
  await ui.settle()
  assert.equal(ui.find(n => n.props.className === 'uic-agent-plan').props.open, undefined)
  assert.ok(ui.find(n => n.props.className === 'uic-agent-add-status' && n.props.children === '已完成'))
  assert.equal(ui.timers.size, 0)
  assert.equal(ui.pointers.at(-2).slots[0].x, 410)
  assert.deepEqual(ui.pointers.at(-1), {requestId, sessionId:'s1', pageId:'p1', slots:[], finished:true})
})

test('completed turns render the actual model, task list, scoped tool details and measured duration on reopen', async () => {
  const ui = mount([{ prompt:'绘制设置', reply:'完成', plan:{
    elapsedMs:114360, steps:[{title:'执行设计任务', status:'done'}],
    slots:[{index:1, title:'顶部按钮', status:'done', model:{provider:'vendor',model:'two'},
      tasks:[{title:'更新标题',status:'done'},{title:'对齐图标',status:'done'}],
      toolCalls:[{name:'uic_update_plan',status:'success',summary:'确认标题和图标两项任务'},
        {name:'uic_canvas_edit',status:'success',target:'主按钮',summary:'更新按钮文字'}]}],
  }}])
  await ui.settle()
  for (const label of ['Agent 1 · two','更新标题','对齐图标','更新任务计划','更新按钮文字','工作用时 1分54秒']) {
    assert.ok(ui.find(n => n.props.children === label), label)
  }
  assert.equal(ui.find(n => n.props.children === '执行设计任务'), undefined)
})

test('resize grip increases the transcript upward, clamps, restores a cancelled drag and remembers only its workspace', async () => {
  const storage = new Map<string,string>()
  const ui = mount([], 'zh', storage)
  await ui.settle()
  const panel = () => ui.find(n => n.props.className === 'uic-agent-panel')
  const grip = () => ui.byLabel('调整聊天框高度')
  assert.equal(grip().props.role, 'separator')
  assert.equal(grip().props['aria-orientation'], 'horizontal')
  assert.equal(panel().props.style, undefined)
  const box = panel().props.ref.current
  box.closest = () => ({parentElement:{getBoundingClientRect:()=>({top:40})}})
  box.getBoundingClientRect = () => ({height:parseFloat(panel().props.style?.height ?? '200'),bottom:700})
  let capture = false
  const target = { focus() {}, setPointerCapture() { capture = true }, hasPointerCapture: () => capture, releasePointerCapture() { capture = false } }
  const pointer = (y: number, id=1) => ({button:0, pointerId:id, clientY:y, currentTarget:target, preventDefault(){}})
  grip().props.onPointerDown(pointer(400))
  grip().props.onPointerMove(pointer(260, 2))
  ui.render()
  assert.equal(panel().props.style, undefined)
  grip().props.onPointerUp(pointer(300))
  ui.render()
  assert.equal(capture,false)
  assert.equal(panel().props.style.height, '300px')
  assert.equal(storage.get('uic-canvas-chat-height:w1'),'300')
  grip().props.onPointerDown(pointer(300))
  grip().props.onPointerMove(pointer(100))
  ui.render()
  assert.equal(panel().props.style.height, '500px')
  grip().props.onPointerCancel(pointer(100))
  ui.render()
  assert.equal(panel().props.style.height,'300px')
  const key = (key:string) => { grip().props.onKeyDown({key,preventDefault(){},stopPropagation(){}}); ui.render() }
  key('ArrowUp')
  assert.equal(panel().props.style.height,'324px')
  key('End')
  assert.equal(panel().props.style.height,'616px')
  key('Home')
  assert.equal(panel().props.style.height,'108px')
  const reopened = mount([], 'zh', storage)
  assert.equal(reopened.find(n => n.props.className === 'uic-agent-panel').props.style.height,'108px')
  assert.equal(mount([], 'zh', storage, 'w2').find(n => n.props.className === 'uic-agent-panel').props.style, undefined)
})
