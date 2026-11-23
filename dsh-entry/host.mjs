import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { ensureProjectCanvas, resolveProjectBinding, workspaceIdFromRequest } from './project-binding.mjs'
import { isLoopbackRemoteAddress } from './editor-host.js'
import { assetDataUrl, findAsset, readProjectConfig, saveAsset, writeProjectConfig } from './asset-store.mjs'
import { insertCanvasNode } from './agent-editor.mjs'
import {
  activeConversation, appendConversationTurn, createConversation, listConversations, readActiveTurns, selectConversation,
} from './conversations.mjs'
import {
  MAX_DOCUMENT_BYTES,
  PRESENTATION_META_KEY,
  createDocumentSnapshotFromText,
  projectDocumentGrant,
} from './renderer.js'

export const COMPILER_CANVAS_ROUTE = '/_dsh/dsh-openpencil/ui-compiler/open'
export const COMPILER_CONFIG_ROUTE = '/_dsh/dsh-openpencil/ui-compiler/config'
export const COMPILER_ASSET_ROUTE = '/_dsh/dsh-openpencil/ui-compiler/asset'
export const COMPILER_IMAGE_ROUTE = '/_dsh/dsh-openpencil/ui-compiler/image'
export const COMPILER_PEN_IMPORT_ROUTE = '/_dsh/dsh-openpencil/ui-compiler/import-pen'
export const COMPILER_CONVERSATIONS_ROUTE = '/_dsh/dsh-openpencil/ui-compiler/conversations'
/** The canvas a project surface most recently opened, for Host drawing tools. */
export const activeCompilerCanvas = { binding: null }
const maxConfigBytes = 16 * 1024
const maxAssetBytes = 32 * 1024 * 1024

/** Read the active canvas conversation's turns. */
export async function readCanvasTurns(binding) {
  return readActiveTurns(binding)
}

/** Append one completed turn to the active canvas conversation. */
export function appendCanvasTurn(binding, turn) {
  return appendConversationTurn(binding, turn)
}

function sendJson(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  })
  res.end(JSON.stringify(payload))
}

// Shared authentication fence for the compiler's local-only routes.
function guard(req, res, requestRejection, method) {
  if (!isLoopbackRemoteAddress(req.socket?.remoteAddress)) {
    sendJson(res, 403, { error: 'forbidden' })
    return false
  }
  let rejection = 401
  try {
    if (typeof requestRejection === 'function') rejection = requestRejection(req)
  } catch {
    sendJson(res, 403, { error: 'forbidden' })
    return false
  }
  if (rejection !== undefined) {
    sendJson(res, rejection === 401 ? 401 : 403, { error: rejection === 401 ? 'authentication_required' : 'forbidden' })
    return false
  }
  if (req.method !== method) {
    sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: method })
    return false
  }
  return true
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers?.['content-length'])
    if (Number.isFinite(declared) && declared > limit) {
      reject(Object.assign(new Error('Request body is too large'), { status: 413 }))
      req.resume()
      return
    }
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > limit) {
        reject(Object.assign(new Error('Request body is too large'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readJsonBody(req, limit) {
  const body = await readBody(req, limit)
  try {
    return JSON.parse(body.toString('utf8') || '{}')
  } catch {
    throw Object.assign(new Error('Invalid JSON body'), { status: 400 })
  }
}

async function registeredWorkspace(workspaceRegistry, request) {
  const workspaceId = workspaceIdFromRequest(request)
  const project = workspaceRegistry.get(workspaceId)
  if (project?.id !== workspaceId || typeof project.path !== 'string' || !isAbsolute(project.path)) {
    throw Object.assign(new Error('Unregistered DSH workspace'), { status: 404 })
  }
  const workspaceRoot = await realpath(project.path)
  if (workspaceRoot !== project.path || !(await lstat(workspaceRoot)).isDirectory()) {
    throw Object.assign(new Error('Workspace root changed'), { status: 404 })
  }
  return { workspaceId, workspaceRoot }
}

function routeFailure(res, error) {
  const status = Number.isInteger(error?.status) ? error.status : 400
  sendJson(res, status, { error: status === 413 ? 'too_large' : status === 404 ? 'workspace_unavailable' : 'invalid_request' })
}

/** Read or update the project's target design and asset folders. */
export function attachCompilerConfigRoute({ workspaceRegistry, requestRejection }) {
  return async (req, res, next) => {
    if (req.url?.split('?', 1)[0] !== COMPILER_CONFIG_ROUTE) return next?.()
    if (!guard(req, res, requestRejection, req.method === 'GET' ? 'GET' : 'POST')) return
    try {
      const { workspaceRoot } = await registeredWorkspace(workspaceRegistry, req)
      if (req.method === 'GET') return sendJson(res, 200, await readProjectConfig(workspaceRoot))
      const body = await readJsonBody(req, maxConfigBytes)
      return sendJson(res, 200, await writeProjectConfig(workspaceRoot, body))
    } catch (error) {
      routeFailure(res, error)
    }
  }
}

/** List, create or select the project canvas's assistant conversations. */
export function attachCompilerConversationsRoute({ workspaceRegistry, requestRejection }) {
  return async (req, res, next) => {
    if (req.url?.split('?', 1)[0] !== COMPILER_CONVERSATIONS_ROUTE) return next?.()
    if (!guard(req, res, requestRejection, req.method === 'GET' ? 'GET' : 'POST')) return
    try {
      const workspaceId = workspaceIdFromRequest(req)
      const binding = await resolveProjectBinding(workspaceRegistry, workspaceId, undefined)
      if (req.method === 'GET') return sendJson(res, 200, await listConversations(binding))
      const body = await readJsonBody(req, 8 * 1024)
      if (body?.action === 'new') {
        const conversation = await createConversation(binding)
        return sendJson(res, 200, { ...await listConversations(binding), conversation })
      }
      if (body?.action === 'select') {
        const conversation = await selectConversation(binding, body?.id)
        return sendJson(res, 200, { ...await listConversations(binding), conversation })
      }
      return sendJson(res, 400, { error: 'invalid_request' })
    } catch (error) {
      routeFailure(res, error)
    }
  }
}

/** Store one uploaded file in the project's configured asset folder. */
export function attachCompilerAssetRoute({ workspaceRegistry, requestRejection }) {
  return async (req, res, next) => {
    if (req.url?.split('?', 1)[0] !== COMPILER_ASSET_ROUTE) return next?.()
    if (!guard(req, res, requestRejection, 'POST')) return
    try {
      const workspaceId = workspaceIdFromRequest(req)
      const binding = await resolveProjectBinding(workspaceRegistry, workspaceId, undefined)
      const filename = decodeURIComponent(req.headers?.['x-uic-filename'] ?? '')
      if (filename === '') throw Object.assign(new Error('Missing file name'), { status: 400 })
      const mimeType = String(req.headers?.['content-type'] ?? 'application/octet-stream').split(';', 1)[0].trim()
      let bytes = await readBody(req, maxAssetBytes)
      if (/\.pen$/iu.test(filename.normalize('NFKC').trim())) {
        const { parsePenDocument } = await import('./pen-document.mjs')
        try {
          // Store only portable design fields. Pencil account/file tokens do
          // not belong in project assets, document identities or model input.
          const { version, children, variables, themes } = parsePenDocument(bytes)
          bytes = Buffer.from(JSON.stringify({ version, children, variables, themes }))
        } catch (error) {
          return sendJson(res, error?.status === 413 ? 413 : 422, { error: 'invalid_pen' })
        }
      }
      const asset = await saveAsset(binding.workspaceRoot, binding.assetDir, { name: filename, mimeType, bytes })
      return sendJson(res, 200, asset)
    } catch (error) {
      routeFailure(res, error)
    }
  }
}

/** Import editable Pencil layers into the active, project-owned canvas. */
export function attachCompilerPenImportRoute({ editorHost, workspaceRegistry, workspaceRoot, requestRejection }) {
  return async (req, res, next) => {
    if (req.url?.split('?', 1)[0] !== COMPILER_PEN_IMPORT_ROUTE) return next?.()
    if (!guard(req, res, requestRejection, 'POST')) return
    try {
      const workspaceId = workspaceIdFromRequest(req)
      const binding = await resolveProjectBinding(workspaceRegistry, workspaceId, workspaceRoot)
      const active = activeCompilerCanvas.binding
      if (!active || ['workspaceId', 'workspaceRoot', 'sourcePath', 'ownerSessionId'].some(key => active[key] !== binding[key])) {
        return sendJson(res, 409, { error: 'canvas_unavailable' })
      }
      const input = await readJsonBody(req, 64 * 1024)
      const { importProjectPen } = await import('./pen-import.mjs')
      const result = await importProjectPen(editorHost, binding, input)
      return sendJson(res, 200, result)
    } catch (error) {
      if (error?.importStatus) {
        return sendJson(res, error.importStatus, {
          error: error.code, ...(error.missing ? { missing: error.missing } : {}),
        })
      }
      if (error?.code === 'canvas_changed') return sendJson(res, 409, { error: 'canvas_changed' })
      routeFailure(res, error)
    }
  }
}

/** Insert an uploaded image into the canvas the project currently has open. */
export function attachCompilerImageRoute({ editorHost, workspaceRegistry, requestRejection }) {
  return async (req, res, next) => {
    if (req.url?.split('?', 1)[0] !== COMPILER_IMAGE_ROUTE) return next?.()
    if (!guard(req, res, requestRejection, 'POST')) return
    try {
      const workspaceId = workspaceIdFromRequest(req)
      const binding = await resolveProjectBinding(workspaceRegistry, workspaceId, undefined)
      const active = activeCompilerCanvas.binding
      if (active === null || active.workspaceId !== workspaceId) {
        return sendJson(res, 409, { error: 'canvas_unavailable' })
      }
      const body = await readJsonBody(req, 8 * 1024)
      const asset = await findAsset(binding.workspaceRoot, binding.assetDir, body?.id)
      if (asset === undefined) return sendJson(res, 404, { error: 'asset_unavailable' })
      const src = assetDataUrl(asset.mimeType, asset.bytes)
      if (src === undefined) return sendJson(res, 415, { error: 'unsupported_image' })
      const width = Number.isFinite(body?.width) && body.width > 0 ? Math.min(body.width, 4096) : 480
      const height = Number.isFinite(body?.height) && body.height > 0 ? Math.min(body.height, 4096) : 360
      const node = { type: 'image', name: asset.name, src, width, height }
      if (Number.isFinite(body?.x) && Number.isFinite(body?.y)) Object.assign(node, { x: body.x, y: body.y })
      const result = await insertCanvasNode(editorHost, node, {
        sourcePath: active.sourcePath,
        ownerSessionId: active.ownerSessionId,
        signal: AbortSignal.timeout(20000),
      })
      return sendJson(res, 200, result)
    } catch (error) {
      routeFailure(res, error)
    }
  }
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
      activeCompilerCanvas.binding = {
        workspaceId, workspaceRoot: binding.workspaceRoot, assetDir: binding.assetDir,
        sourcePath, ownerSessionId: binding.ownerSessionId,
      }
      const { url, bytes, sha256, mimeType } = grant.document
      let conversation = { id: null, title: '', turns: [] }
      let conversations = []
      let historyUnavailable = false
      try {
        conversation = await activeConversation(binding)
        conversations = (await listConversations(binding)).conversations
      } catch { historyUnavailable = true }
      return sendJson(res, 200, {
        schemaVersion: grant.schemaVersion,
        document: { path: binding.canvasFile, url, bytes, sha256, mimeType },
        workspaceId, ownerSessionId: binding.ownerSessionId, projectTitle: binding.projectTitle,
        editor, conversationId: conversation.id, conversationTitle: conversation.title,
        conversations, turns: conversation.turns, historyUnavailable,
      })
    } catch {
      return sendJson(res, 503, { error: 'editor_unavailable' })
    }
  }
}
