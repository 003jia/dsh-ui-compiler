import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const { ensureProjectCanvas, resolveProjectBinding, workspaceIdFromRequest } =
  await import(new URL('../dsh-entry/project-binding.mjs', import.meta.url).href)

test('only registered projects own canvases and a simultaneous first open never replaces saved work', async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'uic-project-binding-')))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const legacy = join(dir, '原稿')
  const fresh = join(dir, '前端项目')
  const redirected = join(dir, 'another')
  await Promise.all([legacy, fresh, redirected].map(path => mkdir(path)))
  const registry = new Map([['one', { id: 'one', title: '原稿', path: legacy }],
    ['two', { id: 'two', title: '前端项目', path: fresh }],
    ['three', { id: 'three', title: '独立', path: redirected }]])
  const old = await resolveProjectBinding(registry, 'one', legacy)
  const next = await resolveProjectBinding(registry, 'two', legacy)
  const other = await resolveProjectBinding(registry, 'three', legacy)
  assert.equal(old.canvasFile, 'design/pages/mcp-center.op')
  assert.equal(next.canvasFile, 'design/pages/ui.op')
  assert.notEqual(next.ownerSessionId, old.ownerSessionId)
  await assert.rejects(resolveProjectBinding(registry, 'unknown', legacy))
  assert.throws(() => workspaceIdFromRequest({ headers: { 'x-uic-workspace': fresh } }))
  await Promise.all([ensureProjectCanvas(next), ensureProjectCanvas(next)])
  assert.deepEqual(JSON.parse(await readFile(next.sourcePath, 'utf8')).children, [])
  await writeFile(next.sourcePath, '{"version":"1.0.0","children":[],"custom":"保留"}')
  await ensureProjectCanvas(next)
  assert.equal(JSON.parse(await readFile(next.sourcePath, 'utf8')).custom, '保留')
  await symlink(join(fresh, 'design'), join(redirected, 'design'), 'dir')
  await assert.rejects(ensureProjectCanvas(other))
  await assert.rejects(readFile(old.sourcePath), { code: 'ENOENT' })
})

test('project history and preview responses remain distinct even with identical document bytes', async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'uic-project-owners-')))
  t.after(() => rm(dir, { recursive: true, force: true }))
  for (const [file, target] of [
    ['host.mjs', 'ui-compiler-host.mjs'], ['project-binding.mjs', 'project-binding.mjs'], ['preview-host.mjs', 'preview-host.mjs'],
  ]) await cp(new URL('../dsh-entry/' + file, import.meta.url), join(dir, target))
  await writeFile(join(dir, 'package.json'), '{"type":"module"}')
  await writeFile(join(dir, 'editor-host.js'), 'export const isLoopbackRemoteAddress = value => value === "127.0.0.1"')
  await writeFile(join(dir, 'renderer.js'), [
    "export const MAX_DOCUMENT_BYTES = 10000, PRESENTATION_META_KEY = 'doc'",
    "export const createDocumentSnapshotFromText = text => ({ bytes: Buffer.byteLength(text), sha256: 'digest' })",
    "export const projectDocumentGrant = ({document}, controller, editor) => ({doc: {schemaVersion: 1, document, editor}})",
  ].join('\n'))
  const { readCanvasTurns, appendCanvasTurn, attachCompilerCanvasRoute, COMPILER_CANVAS_ROUTE } = await import(pathToFileURL(join(dir, 'ui-compiler-host.mjs')).href)
  const { attachCompilerPreviewRoute, COMPILER_PREVIEW_ROUTE } = await import(pathToFileURL(join(dir, 'preview-host.mjs')).href)
  const registry = new Map()
  for (const id of ['a', 'b']) {
    const path = join(dir, id)
    await mkdir(path)
    registry.set(id, { id, title: id, path })
  }
  const [a, b] = await Promise.all(['a', 'b'].map(id => resolveProjectBinding(registry, id, dir)))
  const open = attachCompilerCanvasRoute({
    workspaceRoot: dir, workspaceRegistry: registry, controller: { routeAvailable: true },
    requestRejection: () => undefined,
    editorHost: { available: true, routeAvailable: true, grantFor: (sourcePath: string) => ({ sourcePath }) },
  })
  async function post(route: typeof open, url: string, id: string) {
    let code = 0
    let payload: { html?: string; workspaceId?: string; ownerSessionId?: string; editor?: { sourcePath: string } } = {}
    const res = { writeHead(status: number) { code = status }, end(body: string) { payload = JSON.parse(body) } }
    await route({ url, method: 'POST', headers: { 'x-uic-workspace': id }, socket: { remoteAddress: '127.0.0.1' } }, res)
    return { code, payload }
  }
  assert.equal((await post(open, COMPILER_CANVAS_ROUTE, '/untrusted/project')).code, 400)
  assert.equal((await post(open, COMPILER_CANVAS_ROUTE, 'lost')).code, 404)
  await assert.rejects(readFile(a.sourcePath), { code: 'ENOENT' })
  const opened = await Promise.all(['a', 'b'].map(id => post(open, COMPILER_CANVAS_ROUTE, id)))
  assert.deepEqual(opened.map(result => result.payload.editor?.sourcePath), [a.sourcePath, b.sourcePath])
  assert.deepEqual(opened.map(result => result.payload.ownerSessionId), [a.ownerSessionId, b.ownerSessionId])
  const [turn1, turn2] = [{ prompt: '第一轮', reply: '一' }, { prompt: '第二轮', reply: '二' }]
  await Promise.all([appendCanvasTurn(a, turn1), appendCanvasTurn(a, turn2)])
  assert.deepEqual(await readCanvasTurns(a), [turn1, turn2])
  assert.deepEqual(await readCanvasTurns(b), [])

  const preview = attachCompilerPreviewRoute({
    workspaceRoot: dir, workspaceRegistry: registry, requestRejection: () => undefined,
    buildCompilerPreview: async (root: string, snapshot: { inputHash: string }) =>
      ({ inputHash: snapshot.inputHash, html: root }),
  })
  async function request(id: string) {
    const { code, payload } = await post(preview, COMPILER_PREVIEW_ROUTE, id)
    assert.equal(code, 200)
    return payload
  }
  const [one, two] = await Promise.all([request('a'), request('b')])
  assert.equal(one.html, a.workspaceRoot)
  assert.equal(two.html, b.workspaceRoot)
  assert.equal((await request('a')).workspaceId, 'a')
})
