import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const sources = new URL('../dsh-entry/', import.meta.url)
const { saveAsset } = await import(new URL('asset-store.mjs', sources).href)
const { importProjectPen } = await import(new URL('pen-import.mjs', sources).href)
const { readCanvasContext } = await import(new URL('agent-editor.mjs', sources).href)

const root = await realpath(await mkdtemp(join(tmpdir(), 'uic-pen-import-')))
test.after(() => rm(root, { recursive: true, force: true }))

const binding = { workspaceRoot: root, assetDir: 'assets', ownerSessionId: 'uic-sidebar-test', sourcePath: join(root, 'design.op') }
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO9vXSsAAAAASUVORK5CYII=', 'base64')
const resource = await saveAsset(root, binding.assetDir, { name: 'picture.png', mimeType: 'image/png', bytes: png })
const sample = {
  version: '2.21', variables: { brand: { type: 'color', value: '#ff0000' } },
  children: [{ id: 'board', type: 'frame', name: 'Browser', width: 360, height: 240, x: 20, y: 20,
    children: [
      { id: 'title', type: 'text', name: 'Title', content: 'Current tab', width: 100, height: 20, fill: '$brand' },
      { id: 'picture', type: 'rectangle', width: 80, height: 80, fill: [{ type: 'image', url: 'images/picture.png', mode: 'fill' }] },
    ] }],
}
const pen = await saveAsset(root, binding.assetDir, { name: 'my.pen', mimeType: 'application/octet-stream', bytes: Buffer.from(JSON.stringify(sample)) })
const request = { id: pen.id, resources: [{ path: 'images/picture.png', id: resource.id }] }

function fakeHost() {
  const original = { id: 'original', type: 'frame', name: 'Existing board', x: 10, y: 10, width: 400, height: 80, children: [] }
  let document: any = {
    version: '1.0.0', variables: { brand: { type: 'color', value: '#ffffff' } },
    pages: [{ id: 'empty', name: 'Another page', children: [] }, { id: 'current', name: 'Current', children: [original] }],
  }
  let version = 6, writes = 0
  let selectedIds: string[] = []
  const live = {
    id: 'session', read: async () => ({ documentJson: JSON.stringify(document), version }),
    selection: async () => ({ activePageId: 'current', selectedIds, nodes: [] }),
    call: async (tool: string, args: any) => {
      if (tool === 'snapshot_layout') return { value: { layout: [original] } }
      assert.equal(tool, 'set_selection')
      selectedIds = [args.node_id]
      return { value: { ok: true } }
    },
    replaceDocument: async (text: string, baseVersion: number) => {
      assert.equal(baseVersion, version)
      document = JSON.parse(text)
      ++writes
      return ++version
    },
  }
  const editor = {
    withCompilerCanvas: async (options: any, op: Function) => {
      assert.equal(options.sourcePath, binding.sourcePath)
      assert.equal(options.ownerSessionId, binding.ownerSessionId)
      return op(live)
    },
  }
  return { editor, live, document: () => document, writes: () => writes, original }
}

test('merges editable nodes into the active page, namespaces variables and imports identical bytes only once', async () => {
  const host = fakeHost()
  const result = await importProjectPen(host.editor, binding, request)
  assert.equal(result.boardCount, 1)
  assert.equal(result.layerCount, 3)
  assert.deepEqual(host.document().pages[0].children, [])
  const [old, imported] = host.document().pages[1].children
  assert.deepEqual(old, host.original)
  assert.ok(imported.x >= old.x + old.width)
  assert.equal(imported.y, 20)
  assert.ok(imported.id.startsWith('pen_' + pen.id + '_'))
  assert.equal(imported.id, result.firstBoardId)
  assert.equal(imported.children[0].content, 'Current tab')
  assert.match(JSON.stringify(imported.children[1]), /data:image\/png;base64,/u)
  assert.deepEqual(host.document().variables.brand, { type: 'color', value: '#ffffff' })
  imported.children[0].content = 'An actual edit'
  const duplicate = await importProjectPen(host.editor, binding, { id: pen.id })
  assert.equal(duplicate.alreadyImported, true)
  assert.equal(imported.children[0].content, 'An actual edit')
  assert.equal(host.writes(), 1)
  const context = await readCanvasContext(host.editor, { ...binding, describePage: (nodes: any[], selected: string[]) => ({
    selected: selected[0], title: nodes[1].children[0].content,
  }) })
  assert.deepEqual(context.context.designStructure, { selected: imported.id, title: 'An actual edit' })
})

test('missing, unrelated and invalid resources do not change the live document', async () => {
  const host = fakeHost()
  await assert.rejects(importProjectPen(host.editor, binding, { id: pen.id }),
    { code: 'pen_resources_required', missing: ['images/picture.png'] })
  await assert.rejects(importProjectPen(host.editor, binding, { id: pen.id,
    resources: [{ path: '../somewhere.png', id: resource.id }] }), { code: 'invalid_request' })
  await assert.rejects(importProjectPen(host.editor, binding, { id: pen.id,
    resources: [{ path: 'images/picture.png', id: 'b'.repeat(64) }] }), { code: 'asset_unavailable' })
  const mislabeled = await saveAsset(root, binding.assetDir, {
    name: 'wrong.png', mimeType: 'image/png', bytes: Buffer.from('not image bytes'),
  })
  await assert.rejects(importProjectPen(host.editor, binding, { id: pen.id,
    resources: [{ path: 'images/picture.png', id: mislabeled.id }] }), { code: 'unsupported_image' })
  assert.equal(host.writes(), 0)
})

test('a concurrent native edit fails the compare-and-swap without a partial import', async () => {
  const host = fakeHost()
  host.live.replaceDocument = async () => { throw Error('OpenPencil recovery restore failed (409)') }
  await assert.rejects(importProjectPen(host.editor, binding, request), { code: 'canvas_changed' })
  assert.deepEqual(host.document().pages[1].children, [host.original])
  assert.equal(host.writes(), 0)
})

test('the local routes save only portable design fields and reject a different project or unauthenticated import', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'uic-pen-routes-')))
  try {
    for (const file of ['host.mjs', 'agent-editor.mjs', 'asset-store.mjs', 'project-binding.mjs',
      'conversations.mjs', 'pen-import.mjs', 'pen-document.mjs']) {
      await cp(new URL(file, sources), join(dir, file))
    }
    await writeFile(join(dir, 'package.json'), '{"type":"module"}')
    await writeFile(join(dir, 'renderer.js'), "export const MAX_DOCUMENT_BYTES=67108864, PRESENTATION_META_KEY='doc', createDocumentSnapshotFromText=()=>{}, projectDocumentGrant=()=>{}")
    await writeFile(join(dir, 'editor-host.js'), "export const isLoopbackRemoteAddress=ip=>ip==='127.0.0.1'")
    const routes = await import(pathToFileURL(join(dir, 'host.mjs')).href)
    const registry = { get: (id: string) => id === 'fixture' ? { id, path: dir, title: 'Fixture' } : undefined }
    const route = (handler: Function, path: string, data: Buffer, headers: any = {}) => {
      const stream: any = Readable.from([data])
      Object.assign(stream, { socket: { remoteAddress: '127.0.0.1' }, method: 'POST', url: path,
        headers: { ...headers, 'x-uic-workspace': 'fixture' } })
      const response = { status: 0, body: null as any,
        writeHead(status: number) { this.status = status }, end(body: string) { this.body = JSON.parse(body) } }
      return handler(stream, response).then(() => response)
    }
    const deps = { workspaceRegistry: registry, requestRejection: () => undefined }
    const upload = (data: unknown) => route(routes.attachCompilerAssetRoute(deps), routes.COMPILER_ASSET_ROUTE,
      Buffer.from(JSON.stringify(data)), { 'x-uic-filename': 'browser.pen' })
    const stored = await upload({ fileToken: 'private-fixture', ...sample })
    assert.equal(stored.status, 200)
    const design = await readFile(join(dir, stored.body.path), 'utf8')
    assert.doesNotMatch(design, /fileToken|private-fixture/u)
    assert.deepEqual(JSON.parse(design).children, sample.children)
    assert.equal((await upload({ version: '2.21', children: 'corrupt' })).status, 422)
    const input = Buffer.from(JSON.stringify({ id: stored.body.id }))
    routes.activeCompilerCanvas.binding = { ...binding, workspaceId: 'different' }
    const unavailable = await route(routes.attachCompilerPenImportRoute(deps), routes.COMPILER_PEN_IMPORT_ROUTE, input)
    assert.equal(unavailable.status, 409)
    assert.equal(unavailable.body.error, 'canvas_unavailable')
    const unauthorized = await route(routes.attachCompilerPenImportRoute({ ...deps, requestRejection: () => 401 }),
      routes.COMPILER_PEN_IMPORT_ROUTE, input)
    assert.equal(unauthorized.status, 401)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
