import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { ensureProjectCanvas, projectDirectory, resolveProjectBinding, workspaceIdFromRequest } from './project-binding.mjs'
import { isLoopbackRemoteAddress } from './editor-host.js'
import {
  MAX_DOCUMENT_BYTES,
  PRESENTATION_META_KEY,
  createDocumentSnapshotFromText,
  projectDocumentGrant,
} from './renderer.js'

export const COMPILER_CANVAS_ROUTE = '/_dsh/dsh-openpencil/ui-compiler/open'
const maxHistoryBytes = 640 * 1024

// Only display text and optional localized receipt data survive an editor session.
// Editable node IDs, fingerprints, model sessions and grants stay in memory.
function transcriptTurn({ prompt, reply, change }) {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 8000 ||
      typeof reply !== 'string' || !reply.trim() || reply.length > 9000) throw new Error('Invalid conversation turn')
  if (change == null) return { prompt, reply }
  if (typeof change.name !== 'string' || change.name.length > 240 || typeof change.revised !== 'boolean') {
    throw new Error('Invalid conversation receipt')
  }
  return { prompt, reply, change: { name: change.name, revised: change.revised } }
}

export async function readCanvasTurns({ workspaceRoot, canvasFile, historyFile }) {
  let file
  try {
    const dir = await projectDirectory(workspaceRoot, ['.dsh', 'ui-compiler'], false)
    file = await open(join(dir, historyFile), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > maxHistoryBytes) throw new Error('Invalid conversation file')
    const data = Buffer.alloc(stat.size)
    let offset = 0
    while (offset < data.length) {
      const { bytesRead } = await file.read(data, offset, data.length - offset, offset)
      if (!bytesRead) throw new Error('Incomplete conversation file')
      offset += bytesRead
    }
    const saved = JSON.parse(data.toString('utf8'))
    if (saved.version !== 1 || saved.document !== canvasFile || !Array.isArray(saved.turns) || saved.turns.length > 6) {
      throw new Error('Invalid conversation file')
    }
    return saved.turns.map(transcriptTurn)
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  } finally {
    await file?.close()
  }
}

async function writeTurn(binding, turn) {
  const { workspaceRoot, canvasFile, historyFile } = binding
  const dir = await projectDirectory(workspaceRoot, ['.dsh', 'ui-compiler'], true)
  const turns = [...await readCanvasTurns(binding), transcriptTurn(turn)].slice(-6)
  const temporary = join(dir, historyFile + '.' + randomUUID())
  const file = await open(temporary, 'wx', 0o600)
  try {
    try {
      await file.writeFile(JSON.stringify({ version: 1, document: canvasFile, turns }))
    } finally {
      await file.close()
    }
    await rename(temporary, join(dir, historyFile))
  } finally {
    await rm(temporary, { force: true })
  }
}

const historyWrites = new Map()
export function appendCanvasTurn(binding, turn) {
  const key = binding.sourcePath
  const prior = historyWrites.get(key) ?? Promise.resolve()
  const next = prior.catch(() => {}).then(() => writeTurn(binding, turn)).finally(() => {
    if (historyWrites.get(key) === next) historyWrites.delete(key)
  })
  historyWrites.set(key, next)
  return next
}

function sendJson(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  })
  res.end(JSON.stringify(payload))
}

/** Read one verified snapshot of the project's bound design. */
export async function readCompilerCanvas({ workspaceRoot, sourcePath }) {
  if (await realpath(workspaceRoot) !== workspaceRoot) throw new Error('Workspace root changed')
  if (await realpath(sourcePath) !== sourcePath) {
    throw new Error('Canvas must not be a symbolic link')
  }

  const file = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await file.stat()
    if (!before.isFile() || before.size < 1 || before.size > MAX_DOCUMENT_BYTES) {
      throw new Error('Invalid canvas size or file type')
    }

    // Read the original size to keep allocation bounded while another process
    // is editing the file. The editor independently revalidates the digest.
    const source = Buffer.alloc(before.size)
    let offset = 0
    while (offset < source.length) {
      const { bytesRead } = await file.read(source, offset, source.length - offset, offset)
      if (bytesRead === 0) throw new Error('Canvas changed while reading')
      offset += bytesRead
    }
    const after = await lstat(sourcePath)
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino ||
      after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
      await realpath(sourcePath) !== sourcePath) {
      throw new Error('Canvas changed while reading')
    }

    return { sourcePath, source, inputHash: createHash('sha256').update(source).digest('hex') }
  } finally {
    await file.close()
  }
}

/** Issue an editable grant only for a registered project's bound design. */
export function attachCompilerCanvasRoute({ editorHost, controller, workspaceRoot, workspaceRegistry, requestRejection }) {
  return async (req, res, next) => {
    if (req.url?.split('?', 1)[0] !== COMPILER_CANVAS_ROUTE) return next?.()
    if (!isLoopbackRemoteAddress(req.socket?.remoteAddress)) {
      return sendJson(res, 403, { error: 'forbidden' })
    }
    let rejection = 401
    try {
      if (typeof requestRejection === 'function') rejection = requestRejection(req)
    } catch {
      return sendJson(res, 403, { error: 'forbidden' })
    }
    if (rejection !== undefined) {
      return rejection === 401
        ? sendJson(res, 401, { error: 'authentication_required' })
        : sendJson(res, 403, { error: 'forbidden' })
    }
    if (req.method !== 'POST') {
      return sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'POST' })
    }
    if (req.url !== COMPILER_CANVAS_ROUTE || req.headers?.['transfer-encoding'] !== undefined ||
        (req.headers?.['content-length'] !== undefined && req.headers['content-length'] !== '0')) {
      return sendJson(res, 400, { error: 'invalid_request' })
    }
    if (!editorHost.available || !editorHost.routeAvailable || !controller.routeAvailable) {
      return sendJson(res, 503, { error: 'editor_unavailable' })
    }

    let workspaceId
    try { workspaceId = workspaceIdFromRequest(req) }
    catch { return sendJson(res, 400, { error: 'invalid_workspace' }) }
    let binding
    try { binding = await resolveProjectBinding(workspaceRegistry, workspaceId, workspaceRoot) }
    catch { return sendJson(res, 404, { error: 'workspace_unavailable' }) }
    let sourcePath
    let documentText
    try {
      await ensureProjectCanvas(binding)
      const canvas = await readCompilerCanvas(binding)
      sourcePath = canvas.sourcePath
      // Preserve every byte of a valid UTF-8 document, including a leading BOM.
      documentText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(canvas.source)
    } catch {
      return sendJson(res, 404, { error: 'canvas_unavailable' })
    }

    try {
      const snapshot = await createDocumentSnapshotFromText(documentText)
      const editor = editorHost.grantFor(sourcePath, snapshot.sha256)
      if (editor === undefined) return sendJson(res, 503, { error: 'editor_unavailable' })
      const projection = projectDocumentGrant({ path: sourcePath, document: snapshot }, controller, editor)
      const grant = projection[PRESENTATION_META_KEY]
      if (grant?.document === undefined) return sendJson(res, 503, { error: 'editor_unavailable' })
      const { url, bytes, sha256, mimeType } = grant.document
      let turns = []
      let historyUnavailable = false
      try { turns = await readCanvasTurns(binding) }
      catch { historyUnavailable = true }
      return sendJson(res, 200, {
        schemaVersion: grant.schemaVersion,
        document: { path: binding.canvasFile, url, bytes, sha256, mimeType },
        workspaceId, ownerSessionId: binding.ownerSessionId, projectTitle: binding.projectTitle,
        editor, turns, historyUnavailable,
      })
    } catch {
      return sendJson(res, 503, { error: 'editor_unavailable' })
    }
  }
}
