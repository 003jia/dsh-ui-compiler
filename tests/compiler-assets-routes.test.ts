import assert from 'node:assert/strict'
import test from 'node:test'
import { cp, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Readable } from 'node:stream'
import { registerHooks } from 'node:module'

// Exercise the compiler's local routes and drawing tools with the same
// relative module names the packaged plugin uses. The editor host is a
// recording stub; no OpenPencil runtime is started.

async function scratchCopy() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'uic-routes-')))
  const sources = new URL('../dsh-entry/', import.meta.url)
  for (const [file, target] of [
    ['host.mjs', 'ui-compiler-host.mjs'], ['project-binding.mjs', 'project-binding.mjs'],
    ['asset-store.mjs', 'asset-store.mjs'], ['agent-editor.mjs', 'agent-editor.mjs'],
    ['canvas-tools.mjs', 'canvas-tools.mjs'], ['pen-document.mjs', 'pen-document.mjs'], ['pen-import.mjs', 'pen-import.mjs'],
    ['draw-tools.mjs', 'draw-tools.mjs'], ['conversations.mjs', 'conversations.mjs'],
  ]) await cp(new URL(file, sources), join(dir, target))
  await writeFile(join(dir, 'editor-host.js'), 'export const isLoopbackRemoteAddress = value => value === "127.0.0.1"')
  await writeFile(join(dir, 'renderer.js'), [
    "export const MAX_DOCUMENT_BYTES = 1048576, PRESENTATION_META_KEY = 'doc'",
    'export const createDocumentSnapshotFromText = text => ({ bytes: Buffer.byteLength(text), sha256: "digest" })',
    'export const projectDocumentGrant = () => ({})',
  ].join('\n'))
  await writeFile(join(dir, 'package.json'), '{"type":"module"}')
  return dir
}

function request(url: string, method: string, headers: any = {}, body: Buffer = Buffer.alloc(0)) {
  const stream: any = Readable.from(body.length === 0 ? [] : [body])
  stream.socket = { remoteAddress: '127.0.0.1' }
  stream.method = method
  stream.url = url
  stream.headers = headers
  return stream
}

function response() {
  return {
    status: 0, body: '', headers: {},
    writeHead(status: number, headers: any = {}) { this.status = status; this.headers = headers },
    end(body: string) { this.body = body },
    json() { return JSON.parse(this.body) },
  }
}

function fakeEditor() {
  const calls: any[] = []
  let page: { id: string; name: string; children: any[] } = { id: 'page-1', name: 'Page', children: [] }
  const live = {
    id: 'session-1',
    async selection() { return { activePageId: page.id, selectedIds: [], nodes: [] } },
    async read() { return { documentJson: JSON.stringify({ pages: [page] }) } },
    async call(tool: string, args: any) {
      calls.push({ tool, args })
      if (tool === 'insert_node') {
        const node = { ...args.data, id: 'node-' + (page.children.length + 1) }
        page.children.push(node)
        return { value: { ok: true } }
      }
      if (tool === 'update_node') {
        const node = page.children.find(child => child.id === args.nodeId)
        if (node) Object.assign(node, args.data)
        return { value: { ok: true } }
      }
      if (tool === 'set_selection') return { value: { ok: true } }
      if (tool === 'snapshot_layout') {
        return { value: { layout: page.children.map((child, index) => ({ id: child.id, x: index * 200, y: 0, width: 100, height: 50 })) } }
      }
      return { value: {} }
    },
  }
  const host = {
    calls,
    async withCompilerCanvas(options: any, operation: (live: any) => any) { return operation(live) },
  }
  return { host, calls, page: () => page }
}

const root = await scratchCopy()
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@deepseek-ai/dsh-tools') {
      return next('data:text/javascript,export const defineTool = tool => tool', context)
    }
    return next(specifier, context)
  },
})
const moduleUrl = pathToFileURL(join(root, 'ui-compiler-host.mjs')).href
const { attachCompilerConfigRoute, attachCompilerAssetRoute, attachCompilerImageRoute, attachCompilerConversationsRoute,
  activeCompilerCanvas, COMPILER_CONFIG_ROUTE, COMPILER_ASSET_ROUTE, COMPILER_IMAGE_ROUTE, COMPILER_CONVERSATIONS_ROUTE } = await import(moduleUrl)
const { createCompilerDrawTools } = await import(pathToFileURL(join(root, 'draw-tools.mjs')).href)
const registry = { get: (id: string) => id === 'ws1' ? { id: 'ws1', path: root, title: 'Fixture' } : undefined }
const requestRejection = () => undefined

test.after(() => { hooks.deregister(); return rm(root, { recursive: true, force: true }) })

test('target folders round-trip through the project config route', async () => {
  const route = attachCompilerConfigRoute({ workspaceRegistry: registry, requestRejection })
  const get = response()
  await route(request(COMPILER_CONFIG_ROUTE, 'GET', { 'x-uic-workspace': 'ws1' }), get, undefined)
  assert.equal(get.status, 200)
  assert.deepEqual(get.json(), { designDir: 'design/pages', assetDir: 'design/assets', configured: false })

  const post = response()
  const body = Buffer.from(JSON.stringify({ designDir: 'drafts', assetDir: 'uploads' }))
  await route(request(COMPILER_CONFIG_ROUTE, 'POST', { 'x-uic-workspace': 'ws1', 'content-length': String(body.length) }, body), post, undefined)
  assert.equal(post.status, 200)
  assert.deepEqual(post.json(), { designDir: 'drafts', assetDir: 'uploads' })
  const stored = JSON.parse(await readFile(join(root, '.dsh/ui-compiler/config.json'), 'utf8'))
  assert.deepEqual(stored, { designDir: 'drafts', assetDir: 'uploads' })
})

test('uploaded files are stored in the configured asset folder', async () => {
  // Restore defaults so the binding used by the image route matches this test.
  await writeFile(join(root, '.dsh/ui-compiler/config.json'), JSON.stringify({ designDir: 'design/pages', assetDir: 'design/assets' }))
  const route = attachCompilerAssetRoute({ workspaceRegistry: registry, requestRejection })
  const bytes = Buffer.from('png-bytes')
  const res = response()
  await route(request(COMPILER_ASSET_ROUTE, 'POST', {
    'x-uic-workspace': 'ws1', 'x-uic-filename': encodeURIComponent('hero.png'), 'content-type': 'image/png',
    'content-length': String(bytes.length),
  }, bytes), res, undefined)
  assert.equal(res.status, 200)
  const asset = res.json()
  assert.match(asset.id, /^[a-f0-9]{64}$/)
  assert.equal(asset.mimeType, 'image/png')
  assert.ok(asset.path.startsWith('design/assets/'))
  assert.deepEqual(await readFile(join(root, asset.path)), bytes)
})

test('an uploaded image is inserted into the open canvas', async () => {
  const editor = fakeEditor()
  activeCompilerCanvas.binding = {
    workspaceId: 'ws1', workspaceRoot: root, assetDir: 'design/assets',
    sourcePath: join(root, 'design/pages/ui.op'), ownerSessionId: 'uic-sidebar-ws1',
  }
  const route = attachCompilerImageRoute({ editorHost: editor.host, workspaceRegistry: registry, requestRejection })
  const body = Buffer.from(JSON.stringify({ id: 'a'.repeat(64) }))
  const missing = response()
  await route(request(COMPILER_IMAGE_ROUTE, 'POST', { 'x-uic-workspace': 'ws1', 'content-length': String(body.length) }, body), missing, undefined)
  assert.equal(missing.status, 404)

  const upload = attachCompilerAssetRoute({ workspaceRegistry: registry, requestRejection })
  const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])
  const assetResponse = response()
  await upload(request(COMPILER_ASSET_ROUTE, 'POST', {
    'x-uic-workspace': 'ws1', 'x-uic-filename': 'card.png', 'content-type': 'image/png',
    'content-length': String(image.length),
  }, image), assetResponse, undefined)
  const asset = assetResponse.json()
  const inserted = response()
  const payload = Buffer.from(JSON.stringify({ id: asset.id, width: 320, height: 200 }))
  await route(request(COMPILER_IMAGE_ROUTE, 'POST', { 'x-uic-workspace': 'ws1', 'content-length': String(payload.length) }, payload), inserted, undefined)
  assert.equal(inserted.status, 200)
  assert.equal(inserted.json().id, 'node-1')
  const insert = editor.calls.find(call => call.tool === 'insert_node')
  assert.equal(insert.args.data.type, 'image')
  assert.match(insert.args.data.src, /^data:image\/png;base64,/)
  assert.equal(insert.args.data.width, 320)
})

test('drawing tools select, draw, move and place images on the active canvas', async () => {
  const editor = fakeEditor()
  activeCompilerCanvas.binding = {
    workspaceId: 'ws1', workspaceRoot: root, assetDir: 'design/assets',
    sourcePath: join(root, 'design/pages/ui.op'), ownerSessionId: 'uic-sidebar-ws1',
  }
  const [select, draw, move, image] = createCompilerDrawTools(editor.host, activeCompilerCanvas)
  const selection = await select.execute({}, { signal: new AbortController().signal })
  assert.equal(selection.pageId, 'page-1')
  assert.equal(selection.frames.length, 0)

  const drawn = await draw.execute({ type: 'rectangle', width: 120, height: 40, fill: '#203040' }, { signal: new AbortController().signal })
  assert.equal(drawn.name, 'rectangle')
  const inserted = editor.page().children[0]
  assert.equal(inserted.type, 'rectangle')
  assert.deepEqual(inserted.fill, [{ type: 'solid', color: '#203040' }])

  const moved = await move.execute({ nodeId: inserted.id, x: 10, y: 20 }, { signal: new AbortController().signal })
  assert.equal(moved.x, 10)
  assert.equal(moved.y, 20)

  const upload = attachCompilerAssetRoute({ workspaceRegistry: registry, requestRejection })
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47])
  const assetResponse = response()
  await upload(request(COMPILER_ASSET_ROUTE, 'POST', {
    'x-uic-workspace': 'ws1', 'x-uic-filename': 'shot.png', 'content-type': 'image/png',
    'content-length': String(bytes.length),
  }, bytes), assetResponse, undefined)
  const placed = await image.execute({ assetId: assetResponse.json().id }, { signal: new AbortController().signal })
  assert.equal(placed.type, 'image')
  const last = editor.page().children.at(-1)
  assert.ok(last)
  assert.match(last.src, /^data:image\/png;base64,/)
})


test('canvas edit permissions use only text from the latest user-authored message', async () => {
  const host = { withCompilerCanvas: (options: any) => options }
  const active = { binding: { workspaceRoot: root, sourcePath: join(root, 'design/pages/ui.op'), ownerSessionId: 'sidebar-test' } }
  const edit = createCompilerDrawTools(host, active).find((tool: any) => tool.name === 'uic_canvas_edit')
  const prompt = '删除箭头，将图标换成太阳'
  const args = { sessionId: 's', pageId: 'p', version: 1, operations: [{ op: 'remove', id: 'arrow' }] }
  const cases = [
    { content: prompt, allowed: true },
    { content: [{ type: 'text', text: '删除箭头' }, { type: 'text', text: '将图标换成太阳' }], allowed: true },
    { content: [{ type: 'image', text: prompt }], allowed: false },
  ]
  for (const { content, allowed } of cases) {
    const messages = [
      { role: 'user', source: { kind: 'user' }, content: prompt },
      { role: 'user', source: { kind: 'user' }, content },
      { role: 'user', source: { kind: 'plugin' }, content: prompt },
    ]
    const options = await edit.execute(args, { agent: { session: { header: { cwd: root }, deriveMessages: () => messages } } })
    assert.equal(options.allowDelete, allowed)
    assert.equal(options.allowIconReplacement, allowed)
  }
})

test('conversation routes list, create and select the project canvas chat', async () => {
  const route = attachCompilerConversationsRoute({ workspaceRegistry: registry, requestRejection })
  const initial = response()
  await route(request(COMPILER_CONVERSATIONS_ROUTE, 'GET', { 'x-uic-workspace': 'ws1' }), initial, undefined)
  assert.equal(initial.status, 200)
  const start = initial.json()
  assert.equal(start.conversations.length, 1)
  assert.equal(start.activeId, start.conversations[0].id)

  const created = response()
  const createBody = Buffer.from(JSON.stringify({ action: 'new' }))
  await route(request(COMPILER_CONVERSATIONS_ROUTE, 'POST', {
    'x-uic-workspace': 'ws1', 'content-length': String(createBody.length),
  }, createBody), created, undefined)
  assert.equal(created.status, 200)
  const next = created.json()
  assert.notEqual(next.activeId, start.activeId)
  assert.equal(next.conversations.length, 2)
  assert.deepEqual(next.conversation.turns, [])

  const selected = response()
  const selectBody = Buffer.from(JSON.stringify({ action: 'select', id: start.activeId }))
  await route(request(COMPILER_CONVERSATIONS_ROUTE, 'POST', {
    'x-uic-workspace': 'ws1', 'content-length': String(selectBody.length),
  }, selectBody), selected, undefined)
  assert.equal(selected.status, 200)
  assert.equal(selected.json().activeId, start.activeId)
})
