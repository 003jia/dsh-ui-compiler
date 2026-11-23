import { assetDataUrl, findAsset } from './asset-store.mjs'
import { convertPenDocument, parsePenDocument, referencedPenImages } from './pen-document.mjs'

const maxDocumentBytes = 64 * 1024 * 1024
const maxResourceCount = 128
const assetId = /^[a-f0-9]{64}$/u

function issue(code, importStatus, extra) {
  return Object.assign(new Error(code), { code, importStatus }, extra)
}

function pagesAndActive(doc, activePageId) {
  if (!Array.isArray(doc.pages) || !doc.pages.length) {
    if (!Array.isArray(doc.children)) throw issue('canvas_changed', 409)
    return { pages: [doc], page: doc }
  }
  const page = doc.pages.find(p => p.id === activePageId) ??
    (/^\d+$/u.test(activePageId) ? doc.pages[Number(activePageId)] : null)
  if (!page || doc.pages.some(p => !Array.isArray(p.children))) throw issue('canvas_changed', 409)
  return { pages: doc.pages, page }
}

function countTree(roots, visit) {
  const stack = [...roots]
  let count = 0
  while (stack.length) {
    const node = stack.pop()
    ++count
    visit?.(node)
    for (const child of node.children ?? []) stack.push(child)
  }
  return count
}

function existingImport(pages, namespace, activePageId) {
  for (const page of pages) {
    const roots = page.children.filter(node => node.id?.startsWith(namespace))
    if (roots.length) return {
      boardCount: roots.length, layerCount: countTree(roots), firstBoardId: roots[0].id,
      pageId: page.id ?? activePageId, alreadyImported: true, warnings: [],
    }
  }
}

// A single embedded data URL can occur in thousands of image fills. Bound
// the logical serialized size before allocating the JSON string for the daemon.
export function serializeDocument(doc) {
  const stack = [doc]
  let minimumBytes = 0
  while (stack.length) {
    const value = stack.pop()
    if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        if (!Array.isArray(value)) minimumBytes += Buffer.byteLength(key)
        stack.push(item)
      }
    } else if (typeof value === 'string') {
      minimumBytes += Buffer.byteLength(value)
    }
    if (minimumBytes > maxDocumentBytes) throw issue('too_large', 413)
  }
  const text = JSON.stringify(doc)
  if (Buffer.byteLength(text) > maxDocumentBytes) throw issue('too_large', 413)
  return text
}

function appendDesign(doc, page, imported, offset) {
  const pages = doc.pages?.length ? doc.pages : [doc]
  const ids = new Set()
  for (const p of pages) {
    if (p.id) ids.add(p.id)
    countTree(p.children, node => ids.add(node.id))
  }
  countTree(imported.children, node => {
    if (ids.has(node.id)) throw issue('pen_id_conflict', 409)
    ids.add(node.id)
  })
  for (const key of ['variables', 'themes']) {
    const collection = imported[key]
    if (!collection || !Object.keys(collection).length) continue
    if (Object.keys(collection).some(name => Object.hasOwn(doc[key] ?? {}, name))) throw issue('pen_id_conflict', 409)
    doc[key] = { ...doc[key], ...collection }
  }
  if (offset !== 0) {
    for (const node of imported.children) node.x = (node.x ?? 0) + offset
  }
  for (const node of imported.children) page.children.push(node)
}

function rasterMime(bytes) {
  if (bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'image/png'
  if (bytes.subarray(0, 3).toString('hex') === 'ffd8ff') return 'image/jpeg'
  if (/^GIF8[79]a$/u.test(bytes.toString('ascii', 0, 6))) return 'image/gif'
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
}

async function readResources(binding, parsed, requested) {
  const paths = new Set(referencedPenImages(parsed))
  if (paths.size > maxResourceCount) throw issue('too_large', 413)
  if (!Array.isArray(requested) || requested.length > maxResourceCount) throw issue('invalid_request', 400)
  const references = new Map()
  for (const resource of requested) {
    if (!paths.has(resource?.path) || !assetId.test(resource?.id) || references.has(resource.path)) {
      throw issue('invalid_request', 400)
    }
    references.set(resource.path, resource.id)
  }
  const missing = [...paths].filter(path => !references.has(path))
  if (missing.length) throw issue('pen_resources_required', 422, { missing })
  const assets = new Map()
  let totalBytes = 0
  for (const [path, id] of references) {
    const asset = await findAsset(binding.workspaceRoot, binding.assetDir, id)
    if (!asset) throw issue('asset_unavailable', 404)
    totalBytes += asset.bytes.length
    if (totalBytes > 32 * 1024 * 1024) throw issue('too_large', 413)
    const dataUrl = assetDataUrl(rasterMime(asset.bytes), asset.bytes)
    if (!dataUrl) throw issue('unsupported_image', 415)
    assets.set(path, dataUrl)
  }
  return assets
}

async function importOffset(live, page, pageId, children) {
  if (page.children.length === 0) return 0
  const result = await live.call('snapshot_layout', { pageId, maxDepth: 0 })
  const boxes = result.value?.layout
  if (!Array.isArray(boxes) || !boxes.length || boxes.some(b => !Number.isFinite(b.x) || !Number.isFinite(b.width))) {
    throw issue('canvas_changed', 409)
  }
  const right = boxes.reduce((max, box) => Math.max(max, box.x + box.width), -Infinity)
  const left = children.reduce((min, child) => Math.min(min, child.x ?? 0), Infinity)
  return Math.max(0, right + 80 - left)
}

export async function importProjectPen(editorHost, binding, input) {
  if (!assetId.test(input?.id)) throw issue('invalid_request', 400)
  const asset = await findAsset(binding.workspaceRoot, binding.assetDir, input.id)
  if (!asset) throw issue('asset_unavailable', 404)
  let parsed
  try { parsed = parsePenDocument(asset.bytes) }
  catch { throw issue('invalid_pen', 422) }
  const namespace = 'pen_' + asset.id + '_'
  try {
    return await editorHost.withCompilerCanvas({
      sourcePath: binding.sourcePath, ownerSessionId: binding.ownerSessionId, signal: AbortSignal.timeout(60000),
    }, async live => {
      const [state, selection] = await Promise.all([live.read(), live.selection()])
      const doc = JSON.parse(state.documentJson)
      const { pages, page } = pagesAndActive(doc, selection.activePageId)
      const existing = existingImport(pages, namespace, selection.activePageId)
      if (existing) return existing
      const assets = await readResources(binding, parsed, input.resources ?? [])
      let converted
      try { converted = convertPenDocument(parsed, { namespace, assets }) }
      catch (error) { throw issue(error?.status === 413 ? 'too_large' : 'invalid_pen', error?.status === 413 ? 413 : 422) }
      if (converted.missingAssets?.length) throw issue('pen_resources_required', 422, { missing: converted.missingAssets })
      if (!converted.children.length) throw issue('invalid_pen', 422)
      const offset = await importOffset(live, page, selection.activePageId, converted.children)
      appendDesign(doc, page, converted, offset)
      // Compare against the version of the exact live snapshot we merged. A
      // concurrent native edit or a stale file fails without a partial import.
      const version = await live.replaceDocument(serializeDocument(doc), state.version)
      const saved = await live.read()
      const confirmed = pagesAndActive(JSON.parse(saved.documentJson), selection.activePageId)
      const receipt = existingImport(confirmed.pages, namespace, selection.activePageId)
      if (saved.version < version || !receipt ||
          receipt.boardCount !== converted.boardCount || receipt.layerCount !== converted.nodeCount) {
        throw issue('canvas_changed', 409)
      }
      const firstBoardId = converted.children[0].id
      await live.call('set_selection', { node_id: firstBoardId }, AbortSignal.timeout(5000)).catch(() => {})
      return {
        alreadyImported: false, boardCount: converted.boardCount, layerCount: converted.nodeCount,
        firstBoardId, pageId: selection.activePageId, warnings: converted.warnings,
      }
    })
  } catch (error) {
    if (error.importStatus || error.code === 'canvas_changed') throw error
    if (/409|version conflict/iu.test(error.message)) throw issue('canvas_changed', 409)
    throw issue('canvas_unavailable', 409)
  }
}
