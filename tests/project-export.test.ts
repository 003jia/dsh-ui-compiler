import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const sources = fileURLToPath(new URL('../dsh-entry/', import.meta.url))

test('publishes complete project-local React exports, coalesces concurrent calls and preserves edits', async t => {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'uic-export-test-')))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  // Install the same relative module names used by the packaged DSH plugin.
  await Promise.all([
    copyFile(join(sources, 'export-host.mjs'), join(scratch, 'export-host.mjs')),
    copyFile(join(sources, 'project-binding.mjs'), join(scratch, 'project-binding.mjs')),
    copyFile(join(sources, 'host.mjs'), join(scratch, 'ui-compiler-host.mjs')),
    writeFile(join(scratch, 'editor-host.js'), 'export const isLoopbackRemoteAddress = value => value === "127.0.0.1";'),
    writeFile(join(scratch, 'renderer.js'), 'export const MAX_DOCUMENT_BYTES = 1048576, PRESENTATION_META_KEY = "", createDocumentSnapshotFromText = null, projectDocumentGrant = null;'),
    writeFile(join(scratch, 'package.json'), '{"type":"module"}'),
  ])
  const project = { id: 'registeredProject', path: join(scratch, 'front-end'), title: 'Frontend' }
  const registry = new Map([[project.id, project]])
  const design = join(project.path, 'design/pages/ui.op')
  await mkdir(dirname(design), { recursive: true })
  const source = '{"version":"1.0.0","children":[]}'
  await writeFile(design, source)
  const hash = createHash('sha256').update(source).digest('hex')
  const generated = { 'UiPage.tsx': 'export default () => null', 'CanvasFramePreview.tsx': 'export {}', 'boards.json': '[]' }
  const { attachCompilerExportRoute, COMPILER_EXPORT_ROUTE } = await import(pathToFileURL(join(scratch, 'export-host.mjs')).href)
  let builds = 0
  let onBuild = async () => {}
  const options = {
    workspaceRegistry: registry, workspaceRoot: join(scratch, 'calibration-project'), requestRejection: () => undefined,
    async buildExport(_: unknown, snapshot: { inputHash: string }) {
      builds++
      await onBuild()
      return { inputHash: snapshot.inputHash, files: generated }
    },
  }
  const route = attachCompilerExportRoute(options)

  async function request(workspaceId = project.id, handler = route) {
    let status = 0
    let payload = ''
    const req = { url: COMPILER_EXPORT_ROUTE, method: 'POST', headers: { 'x-uic-workspace': workspaceId }, socket: { remoteAddress: '127.0.0.1' } }
    await handler(req, { writeHead(code: number) { status = code }, end(json: string) { payload = json } })
    return { status, ...JSON.parse(payload) }
  }

  assert.equal((await request('unknown')).status, 404)
  assert.equal((await request('../elsewhere')).status, 400)
  const started = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  onBuild = async () => { started.resolve(); await finish.promise }
  const concurrent = [request(), request()]
  await started.promise
  finish.resolve()
  const results = await Promise.all(concurrent)
  for (const result of results) {
    assert.equal(result.status, 200)
    assert.equal(result.entryPath, 'design/generated/' + hash + '/UiPage.tsx')
  }
  assert.equal(await readFile(join(project.path, results[0].entryPath), 'utf8'), generated['UiPage.tsx'])
  assert.equal(builds, 1)
  assert.equal((await request()).alreadyExported, true)
  await writeFile(join(project.path, results[0].entryPath), 'manually edited')
  assert.equal((await request()).error, 'export_conflict')
  assert.equal(await readFile(join(project.path, results[0].entryPath), 'utf8'), 'manually edited')

  await writeFile(design, source + ' ')
  onBuild = async () => { await writeFile(design, source + '  ') }
  assert.equal((await request()).error, 'canvas_changed')
  assert.deepEqual(await readdir(join(project.path, 'design/generated')), [hash])

  // Independent DSH handler instances cannot share the in-memory promise map.
  const rendezvous = Promise.withResolvers<void>()
  let ready = 0
  onBuild = async () => {
    if (++ready === 2) rendezvous.resolve()
    await rendezvous.promise
  }
  const other = attachCompilerExportRoute(options)
  const competing = await Promise.all([request(), request(project.id, other)])
  assert.deepEqual(competing.map(item => item.status), [200, 200])
  assert.deepEqual(competing.map(item => item.alreadyExported).sort(), [false, true])
})
