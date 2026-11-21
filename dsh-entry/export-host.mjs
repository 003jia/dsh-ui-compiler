import { constants } from 'node:fs'
import { lstat, mkdtemp, open, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isLoopbackRemoteAddress } from './editor-host.js'
import { projectDirectory, resolveProjectBinding, workspaceIdFromRequest } from './project-binding.mjs'
import { readCompilerCanvas } from './ui-compiler-host.mjs'

export const COMPILER_EXPORT_ROUTE = '/_dsh/dsh-openpencil/ui-compiler/export'
const generatedDirectory = ['design', 'generated']
const nativeFiles = ['UiPage.tsx', 'CanvasFramePreview.tsx', 'boards.json']
const mcpFiles = ['McpCenterView.generated.tsx', 'McpCenterView.generated.module.css', 'mcp-center.locales.generated.ts']
const filenames = new Set([...nativeFiles, ...mcpFiles])
const conflict = Symbol('existing source differs')

function verifyBuild(result, inputHash) {
  const files = result?.files
  if (result?.inputHash !== inputHash || !files || typeof files !== 'object' || Array.isArray(files)) {
    throw new Error('Invalid source export')
  }
  const entries = Object.entries(files)
  const required = entries.length === nativeFiles.length ? nativeFiles : [...nativeFiles, ...mcpFiles]
  if (!required.every(name => Object.hasOwn(files, name)) ||
      entries.some(([name, content]) => !filenames.has(name) || typeof content !== 'string')) {
    throw new Error('Invalid source export files')
  }
  return entries
}

async function existingExport(directory, entries) {
  let stat
  try { stat = await lstat(directory) }
  catch (error) { if (error.code === 'ENOENT') return false; throw error }
  if (!stat.isDirectory() || await realpath(directory) !== directory) throw conflict
  for (const [name, content] of entries) {
    let handle
    try {
      handle = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      const info = await handle.stat()
      if (!info.isFile() || info.size !== Buffer.byteLength(content) || await handle.readFile('utf8') !== content) {
        throw conflict
      }
    } catch (error) {
      if (['ENOENT', 'ELOOP', 'EISDIR'].includes(error?.code)) throw conflict
      throw error
    } finally {
      await handle?.close()
    }
  }
  return true
}

// Publish an entire component tree together. If two processes prepare the same
// revision, the second only compares the winning tree; manual edits never move.
async function publish(binding, inputHash, entries, checkCurrent) {
  await checkCurrent()
  const parent = await projectDirectory(binding.workspaceRoot, generatedDirectory, true)
  const target = join(parent, inputHash)
  if (await existingExport(target, entries)) return true
  const stage = await mkdtemp(join(parent, '.uic-export-'))
  try {
    for (const [name, content] of entries) {
      await writeFile(join(stage, name), content, { flag: 'wx', mode: 0o644 })
    }
    await checkCurrent()
    await projectDirectory(binding.workspaceRoot, generatedDirectory, false)
    try { await rename(stage, target) }
    catch (error) {
      if (['ENOTEMPTY', 'EEXIST', 'ENOTDIR', 'EISDIR'].includes(error.code) && await existingExport(target, entries)) return true
      throw error
    }
    return false
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}

function send(res, status, payload, headers = {}) {
  if (res.destroyed || res.writableEnded) return
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers })
  res.end(JSON.stringify(payload))
}

export function attachCompilerExportRoute({ workspaceRegistry, workspaceRoot, requestRejection, buildExport }) {
  const active = new Map()
  const stale = Symbol('design or workspace changed')

  async function exportSnapshot(binding, snapshot) {
    const build = await buildExport(binding, snapshot)
    const entries = verifyBuild(build, snapshot.inputHash)
    async function checkCurrent() {
      const current = await resolveProjectBinding(workspaceRegistry, binding.workspaceId, workspaceRoot)
      if (current.sourcePath !== binding.sourcePath || (await readCompilerCanvas(current)).inputHash !== snapshot.inputHash) throw stale
    }
    return publish(binding, snapshot.inputHash, entries, checkCurrent)
  }

  return async (req, res, next) => {
    if (req.url?.split('?', 1)[0] !== COMPILER_EXPORT_ROUTE) return next?.()
    if (!isLoopbackRemoteAddress(req.socket?.remoteAddress)) return send(res, 403, { error: 'forbidden' })
    let rejection = 401
    try { if (requestRejection) rejection = requestRejection(req) }
    catch { rejection = 403 }
    if (rejection !== undefined) return rejection === 401 ? send(res, 401, { error: 'authentication_required' }) : send(res, 403, { error: 'forbidden' })
    if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' }, { Allow: 'POST' })
    if (req.url !== COMPILER_EXPORT_ROUTE || req.headers['transfer-encoding'] !== undefined ||
        (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0')) {
      return send(res, 400, { error: 'invalid_request' })
    }

    let workspaceId
    try { workspaceId = workspaceIdFromRequest(req) }
    catch { return send(res, 400, { error: 'invalid_workspace' }) }
    let binding
    try { binding = await resolveProjectBinding(workspaceRegistry, workspaceId, workspaceRoot) }
    catch { return send(res, 404, { error: 'workspace_unavailable' }) }
    let snapshot
    try { snapshot = await readCompilerCanvas(binding) }
    catch { return send(res, 404, { error: 'canvas_unavailable' }) }

    const inputHash = snapshot.inputHash
    const entryPath = [...generatedDirectory, inputHash, 'UiPage.tsx'].join('/')
    const key = JSON.stringify([workspaceId, binding.sourcePath, inputHash])
    try {
      if (!active.has(key)) {
        active.set(key, exportSnapshot(binding, snapshot).finally(() => active.delete(key)))
      }
      const alreadyExported = await active.get(key)
      return send(res, 200, { workspaceId, inputHash, entryPath, alreadyExported })
    } catch (error) {
      if (error === stale) return send(res, 409, { error: 'canvas_changed' })
      if (error === conflict) return send(res, 409, { error: 'export_conflict', entryPath })
      return send(res, 500, { error: 'export_failed' })
    }
  }
}
