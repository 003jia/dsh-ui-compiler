import { isLoopbackRemoteAddress } from './editor-host.js'
import { resolveProjectBinding, workspaceIdFromRequest } from './project-binding.mjs'
import { readCompilerCanvas } from './ui-compiler-host.mjs'

export const COMPILER_PREVIEW_ROUTE = '/_dsh/dsh-openpencil/ui-compiler/preview'
const maxPreviewBytes = 4 * 1024 * 1024
const stale = Symbol('canvas changed while compiling')

function sendJson(res, status, payload, extraHeaders = {}) {
  if (res.destroyed || res.writableEnded) return
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  })
  res.end(JSON.stringify(payload))
}

/** Build the selected project's saved data using the packaged preview worker. */
export function attachCompilerPreviewRoute({ workspaceRoot, workspaceRegistry, requestRejection, buildCompilerPreview }) {
  const builds = new Map()
  let cached

  async function buildSnapshot(binding, { inputHash, source }) {
    const preview = await buildCompilerPreview(binding.workspaceRoot, { inputHash, source, canvasFile: binding.canvasFile })
    if (preview?.inputHash !== inputHash || typeof preview.html !== 'string' ||
        preview.html.length === 0 || Buffer.byteLength(preview.html) > maxPreviewBytes) {
      throw new Error('Invalid compiler preview result')
    }
    const current = await resolveProjectBinding(workspaceRegistry, binding.workspaceId, workspaceRoot)
    if (current.sourcePath !== binding.sourcePath || (await readCompilerCanvas(current)).inputHash !== inputHash) throw stale
    cached = { workspaceId: binding.workspaceId, inputHash, html: preview.html }
    return cached
  }

  return async (req, res, next) => {
    if (req.url?.split('?', 1)[0] !== COMPILER_PREVIEW_ROUTE) return next?.()
    if (!isLoopbackRemoteAddress(req.socket?.remoteAddress)) {
      return sendJson(res, 403, { error: 'forbidden' })
    }

    let rejection
    try {
      rejection = typeof requestRejection === 'function' ? requestRejection(req) : 401
    } catch {
      rejection = 403
    }
    if (rejection !== undefined) {
      return rejection === 401
        ? sendJson(res, 401, { error: 'authentication_required' })
        : sendJson(res, 403, { error: 'forbidden' })
    }
    if (req.method !== 'POST') {
      return sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'POST' })
    }
    if (req.url !== COMPILER_PREVIEW_ROUTE || req.headers?.['transfer-encoding'] !== undefined ||
        (req.headers?.['content-length'] !== undefined && req.headers['content-length'] !== '0')) {
      return sendJson(res, 400, { error: 'invalid_request' })
    }

    let workspaceId
    try { workspaceId = workspaceIdFromRequest(req) }
    catch { return sendJson(res, 400, { error: 'invalid_workspace' }) }
    let binding
    let snapshot
    try {
      binding = await resolveProjectBinding(workspaceRegistry, workspaceId, workspaceRoot)
      snapshot = await readCompilerCanvas(binding)
    } catch {
      return sendJson(res, 404, { error: 'canvas_unavailable' })
    }
    if (cached?.workspaceId === workspaceId && cached.inputHash === snapshot.inputHash) {
      return sendJson(res, 200, cached)
    }
    // Separate promise owners even when two newly created projects have the
    // same empty document and therefore the same digest.
    const key = workspaceId + ':' + snapshot.inputHash
    let build = builds.get(key)
    if (!build) {
      build = buildSnapshot(binding, snapshot).finally(() => builds.delete(key))
      builds.set(key, build)
    }
    try {
      return sendJson(res, 200, await build)
    } catch (error) {
      if (error === stale) return sendJson(res, 409, { error: 'preview_stale' })
      return sendJson(res, 500, { error: 'preview_build_failed' })
    }
  }
}
