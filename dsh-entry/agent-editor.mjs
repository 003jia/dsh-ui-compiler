import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

export const iconNames = ['sun','moon','bookmark','settings','search','check','link','arrow-right','chevron-down','chevron-right','x','plus',
  'menu','heart','star','trash-2','copy','bell','home','user','folder','download','info','refresh-cw','palette']

function fail(code) {
  return Object.assign(new Error(code), { code })
}

const fingerprint = node => createHash('sha256').update(JSON.stringify(node)).digest('hex')

// The frame serializes these two default editor settings; the daemon omits them.
// Compare only the decoded contents. Never change the source or the recovery data.
export function compilerRecoveryMatchesSource(sourceJson, recoveryJson) {
  if (!sourceJson.includes('"editorMeta"') && !recoveryJson.includes('"editorMeta"')) return false
  try {
    const source = JSON.parse(sourceJson)
    const recovery = JSON.parse(recoveryJson)
    if (!source || !recovery || Array.isArray(source) || Array.isArray(recovery) ||
        typeof source !== 'object' || typeof recovery !== 'object') return false
    const hasSourceMeta = Object.hasOwn(source, 'editorMeta')
    if (hasSourceMeta === Object.hasOwn(recovery, 'editorMeta')) return false
    const withMeta = hasSourceMeta ? source : recovery
    if (!isDeepStrictEqual(withMeta.editorMeta, {activePageIndex: 0, preserveAuthoredGeometry: false})) return false
    delete withMeta.editorMeta
    return isDeepStrictEqual(source, recovery)
  } catch {
    return false
  }
}

// The installed host owns the live session and its private operation queue.
// Bind only these local design operations to that queue, including stale-editor
// and on-disk source checks. Model output cannot choose a tool or a file.
export function patchCanvasEditorHost(source) {
  if (createHash('sha256').update(source).digest('hex') !==
      'afead6655bb1de2c76ba61c15644bb2b20403e3e16a42be939b4cc64c652e56f') {
    throw new Error('Unexpected OpenPencil editor host version')
  }
  const find = "recovery = await this.#recoveryStore.find(session.sourcePath, session.baselineSha256, current.toString('utf8'));"
  source = source.replace(find, find + `
                    if (recovery && !recovery.sourceChangedSinceCapture && session.ownerSessionId?.startsWith('uic-sidebar-')) {
                        const stored = await this.#recoveryStore.read(session.sourcePath, recovery.id);
                        if (stored && compilerRecoveryMatchesSource(current.toString('utf8'), stored.documentJson)) recovery = undefined;
                    }`)
  const capture = '        return this.#recoveryStore.capture({'
  source = source.replace(capture, `        if (session.ownerSessionId?.startsWith('uic-sidebar-') &&
            sha256(source) === session.baselineSha256 &&
            compilerRecoveryMatchesSource(source.toString('utf8'), daemonDocument.documentJson)) {
            // An older genuine draft may still be awaiting a restore decision.
            // Leave that record untouched when the live canvas matches disk.
            return undefined;
        }
` + capture)
  source = "import { compilerRecoveryMatchesSource } from './agent-editor.mjs';\n" + source
  const anchor = '    async getActiveSelection(options = {}) {'
  return source.replace(anchor, `    async withCompilerCanvas(options, operation) {
        const session = this.#activeSession(options.sourcePath, options.ownerSessionId);
        if (options.sessionId && session.id !== options.sessionId) {
            throw Object.assign(new Error('Canvas changed'), {code: 'canvas_changed'});
        }
        return this.#enqueueSessionOperation(session, async () => {
            options.signal?.throwIfAborted();
            const baseUrl = new URL(session.iframeUrl).origin;
            const read = (signal = options.signal) => readManagedDaemonDocument(baseUrl, session.daemonToken, fetch, signal);
            const selection = () => this.#selectionFor(session, options.signal);
            const replaceDocument = async (documentJson, version) => {
                options.signal?.throwIfAborted();
                if (sha256(await readSourceDocument(session.sourcePath)) !== session.baselineSha256) {
                    throw Object.assign(new Error('Source changed'), {code: 'canvas_changed'});
                }
                session.mutating = true;
                try {
                    return await restoreManagedDaemonDocument(baseUrl, session.daemonToken, {documentJson, version});
                } finally {
                    session.mutating = false;
                }
            };
            const call = async (tool, args, signal = options.signal) => {
                if (!['insert_node', 'replace_node', 'set_selection', 'snapshot_layout', 'update_node'].includes(tool)) throw new Error('Unsupported canvas operation');
                if (tool === 'insert_node' || tool === 'replace_node') {
                    if (sha256(await readSourceDocument(session.sourcePath)) !== session.baselineSha256) {
                        throw Object.assign(new Error('Source changed'), {code: 'canvas_changed'});
                    }
                }
                return callOpenPencilMcp({baseUrl, token: session.daemonToken, tool, arguments: args, signal});
            };
            session.createdAt = Date.now();
            return operation({id: session.id, read, selection, call, replaceDocument});
        });
    }
` + anchor)
}

const types = new Set(['frame', 'text', 'rectangle', 'ellipse', 'image', 'icon_font'])
const typeAliases = { group: 'frame', container: 'frame', artboard: 'frame', rect: 'rectangle', circle: 'ellipse', label: 'text', icon: 'icon_font' }
const numeric = new Set(['gap', 'cornerRadius', 'fontSize', 'x', 'y'])
const enumFields = {
  layout: ['vertical', 'horizontal', 'none'],
  justifyContent: ['start', 'center', 'end', 'space_between', 'space_around', 'space_evenly'],
  alignItems: ['start', 'center', 'end', 'stretch'],
  textAlign: ['left', 'center', 'right', 'justify'],
}
const enumAliases = {
  layout: { row: 'horizontal', column: 'vertical', normal: 'none', absolute: 'none', free: 'none' },
  justifyContent: { flex_start: 'start', flex_end: 'end', normal: 'start', left: 'start', right: 'end' },
  alignItems: { flex_start: 'start', flex_end: 'end', normal: 'start', middle: 'center' },
  textAlign: { start: 'left', end: 'right', middle: 'center' },
}
const weightAliases = { thin: 100, extralight: 200, light: 300, normal: 400, regular: 400, medium: 500,
  semibold: 600, demibold: 600, bold: 700, extrabold: 800, black: 900, heavy: 900 }
const sizes = { fit_content: 'fit_content', auto: 'fit_content', fit: 'fit_content', hug: 'fit_content', hug_contents: 'fit_content',
  fill_container: 'fill_container', fill: 'fill_container', stretch: 'fill_container', '100%': 'fill_container' }
const own = (object, key) => Object.hasOwn(object, key) ? object[key] : undefined
const keyword = value => typeof value === 'string' ? value.trim().replace(/([a-z])([A-Z])/g, '$1_$2').replace(/[\s-]+/g, '_').toLowerCase() : ''
function invalid(path, expected) {
  // The path is constructed solely from fixed schema keys and numeric indices.
  throw Object.assign(fail('invalid_design'), { diagnostic: (path + ': ' + expected).slice(0, 340) })
}
function numberAt(value, path, min = 0, max = 32000) {
  if (typeof value === 'string' && /^-?(?:\d+\.?\d*|\.\d+)(?:px)?$/i.test(value.trim())) {
    value = Number.parseFloat(value)
  }
  if (!Number.isFinite(value) || value < min || value > max) invalid(path, 'expected a number between ' + min + ' and ' + max)
  return value
}
function colorAt(value, path) {
  if (typeof value === 'string') {
    const color = value.trim().toLowerCase()
    const named = own({ transparent: '#00000000', white: '#ffffff', black: '#000000' }, color)
    if (named) return named
    if (/^#(?:[\da-f]{3}|[\da-f]{4})$/.test(color)) return '#' + [...color.slice(1)].map(char => char + char).join('')
    if (/^#(?:[\da-f]{6}|[\da-f]{8})$/.test(color)) return color
    const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*(\d*\.?\d+))?\s*\)$/.exec(color)
    if (rgb && rgb.slice(1, 4).every(v => Number(v) <= 255) && (rgb[4] === undefined || Number(rgb[4]) <= 1)) {
      return '#' + rgb.slice(1).filter(v => v !== undefined).map((v, i) => Math.round(Number(v) * (i === 3 ? 255 : 1)).toString(16).padStart(2, '0')).join('')
    }
  }
  if (value && typeof value === 'object' && ['r', 'g', 'b'].every(k => Number.isFinite(value[k]) && value[k] >= 0 && value[k] <= 1)) {
    const channels = [value.r, value.g, value.b]
    if (value.a !== undefined) channels.push(numberAt(value.a, path, 0, 1))
    return '#' + channels.map(n => Math.round(n * 255).toString(16).padStart(2, '0')).join('')
  }
  invalid(path, 'use a solid hex color such as #203040')
}
function solidFill(value, path) {
  if (keyword(value) === 'none') return []
  const paints = Array.isArray(value) ? value : [value]
  if (paints.length > 4) invalid(path, 'use at most four solid paints')
  return paints.filter(paint => paint?.visible !== false).map(paint => {
    if (paint?.type && keyword(paint.type) !== 'solid') invalid(path, 'use solid paints')
    let color = colorAt(paint?.color ?? paint, path)
    if (paint?.opacity != null) {
      const alpha = color.length === 9 ? parseInt(color.slice(7), 16) : 255
      color = color.slice(0, 7) + Math.round(alpha * numberAt(paint.opacity, path, 0, 1)).toString(16).padStart(2, '0')
    }
    return { type: 'solid', color }
  })
}
function paddingAt(value, path) {
  if (typeof value === 'string') value = value.trim().split(/\s+/)
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    value = ['top', 'right', 'bottom', 'left'].map(k => value[k] ?? 0)
  }
  if (!Array.isArray(value)) return numberAt(value, path)
  if (!value.length || value.length > 4) invalid(path, 'use one to four numeric insets')
  const edges = value.map(n => numberAt(n, path))
  if (edges.length === 1) return edges[0]
  if (edges.length === 3) edges.push(edges[1])
  return edges
}

function cleanFrame(tree) {
  let count = 0
  function visit(raw, depth, path) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid(path, 'expected a layer object')
    if (depth > 16 || ++count > 160) invalid(path, 'use at most 160 layers and 16 levels')
    const kind = keyword(raw.type)
    const type = own(typeAliases, kind) ?? kind
    if (!types.has(type)) invalid(path + '.type', 'use frame, text, rectangle, ellipse, image or icon_font')
    const node = { type }
    const values = { ...raw }
    values.fill ??= type === 'text' ? raw.color ?? raw.textColor ?? raw.fills : raw.backgroundColor ?? raw.background ?? raw.fills
    values.name ??= raw.title
    values.layout ??= raw.layoutMode ?? raw.flexDirection
    values.gap ??= raw.itemSpacing
    values.cornerRadius ??= raw.borderRadius
    if (type === 'icon_font') {
      const icon = raw.iconFontName ?? raw.icon
      if (!iconNames.includes(icon)) invalid(path + '.iconFontName', 'choose a supported Lucide icon')
      node.iconFontName = icon
      node.iconFontFamily = 'lucide'
      values.fill ??= raw.color
    }
    if (type === 'text') values.content ??= raw.text ?? raw.characters
    for (const [key, value] of Object.entries(values)) {
      if (value == null) continue
      const field = path + '.' + key
      if (key === 'name' || key === 'content' || key === 'fontFamily') {
        if (typeof value !== 'string' || value.length > (key === 'content' ? 8000 : 240)) invalid(field, 'use a bounded plain string')
        node[key] = value
      } else if (key === 'width' || key === 'height') {
        const size = depth > 1 ? own(sizes, keyword(value)) : undefined
        node[key] = size ?? numberAt(value, field)
      } else if (key === 'fontWeight') {
        const weight = own(weightAliases, keyword(value).replaceAll('_', ''))
        node.fontWeight = weight ?? numberAt(value, field, 1, 1000)
      } else if (key === 'lineHeight') {
        if (keyword(value) === 'normal') { node.lineHeight = 1.5; continue }
        const percent = typeof value === 'string' && /^\d+(?:\.\d+)?%$/.test(value.trim())
        const line = percent ? numberAt(value.trim().slice(0, -1), field) / 100 : numberAt(value, field)
        // OpenPencil stores line height as a multiple of the font size.
        const inPixels = !percent && (line > 8 || /px$/i.test(String(value).trim()))
        node.lineHeight = inPixels ? line / numberAt(values.fontSize ?? 16, path + '.fontSize', 1) : line
      } else if (numeric.has(key)) {
        node[key] = numberAt(value, field, key === 'x' || key === 'y' ? -32000 : 0)
      } else if (Object.hasOwn(enumFields, key)) {
        const token = keyword(value)
        const normalized = own(enumAliases[key], token) ?? token
        if (!enumFields[key].includes(normalized)) invalid(field, 'use one of ' + enumFields[key].join(', '))
        node[key] = normalized
      } else if (key === 'padding') {
        node.padding = paddingAt(value, field)
      } else if (key === 'fill') {
        node.fill = solidFill(value, field)
      } else if (key === 'stroke') {
        const stroke = typeof value === 'string' ? { fill: value } : value
        if (!stroke || typeof stroke !== 'object' || Array.isArray(stroke)) invalid(field, 'use a solid stroke with fill and thickness')
        node.stroke = { fill: solidFill(stroke.fill ?? stroke.color, field + '.fill'),
          thickness: numberAt(stroke.thickness ?? values.strokeWidth ?? 1, field + '.thickness', 0, 128) }
      } else if (key === 'opacity') {
        node.opacity = numberAt(value, field, 0, 1)
      } else if (key === 'clipContent' && typeof value === 'boolean') {
        node.clipContent = value
      } else if (key === 'src') {
        if (typeof value !== 'string' || value.length === 0 || value.length > 12_000_000) invalid(field, 'use an uploaded asset reference or a bounded image URL')
        if (!/^(?:asset:[a-f0-9]{64}|data:image\/[a-z+.-]+;base64,|https:\/\/)/u.test(value)) invalid(field, 'use asset:<id>, a data:image URL, or https')
        node.src = value
      } else if (key === 'children') {
        if (!Array.isArray(value) || (value.length && type !== 'frame')) invalid(field, 'only a frame may contain child layers')
        if (value.length) node.children = value.map((child, i) => visit(child, depth + 1, field + '[' + i + ']'))
      }
    }
    return node
  }
  const node = visit(tree, 1, 'frame')
  if (node.type !== 'frame') invalid('frame.type', 'the root must be a frame')
  if (!node.name?.trim()) invalid('frame.name', 'give the frame a descriptive name')
  if (!node.children?.length) invalid('frame.children', 'include the editable UI layers')
  if (!(node.width > 0 && node.height > 0)) invalid('frame.width/height', 'give the frame positive pixel dimensions')
  if (JSON.stringify(node).includes('"type":"image"')) requireImageSources(node)
  return { node, count }
}

function requireImageSources(node) {
  if (node.type === 'image' && typeof node.src !== 'string') invalid('frame', 'every image layer needs a src')
  for (const child of node.children ?? []) requireImageSources(child)
}

function replaceAssetSources(node, resolveAsset) {
  if (node.type === 'image' && node.src?.startsWith('asset:')) {
    const resolved = resolveAsset?.(node.src.slice(6))
    if (typeof resolved !== 'string') invalid('frame', 'the referenced upload is unavailable')
    node.src = resolved
  }
  for (const child of node.children ?? []) replaceAssetSources(child, resolveAsset)
}

export function normalizeCanvasFrame(raw) {
  return cleanFrame(raw).node
}

function currentPage(snapshot, pageId) {
  const doc = JSON.parse(snapshot.documentJson)
  const page = doc.pages?.length
    ? doc.pages.find(page => page.id === pageId) ?? (/^\d+$/.test(pageId) ? doc.pages[Number(pageId)] : undefined)
    : doc
  if (!Array.isArray(page?.children)) throw fail('canvas_changed')
  return page
}

function priorNode(page, receipt, sessionId) {
  if (receipt?.sessionId !== sessionId) return undefined
  const node = page.children.find(n => n.id === receipt.id)
  return node && fingerprint(node) === receipt.fingerprint ? node : undefined
}

function summarize(node) {
  return { name: String(node.name ?? '').slice(0, 180), type: node.type, width: node.width, height: node.height }
}

function containsSelection(root, selected) {
  const pending = [root]
  while (pending.length) {
    const node = pending.pop()
    if (selected.has(node.id)) return true
    if (Array.isArray(node.children)) {
      for (const child of node.children) pending.push(child)
    }
  }
  return false
}

// Project occupied rectangles onto a ray so even a row of adjacent boards
// or an auto-sized root cannot be covered by a large generated frame.
function clearPosition(boxes, node, anchor, axis, sign) {
  const gap = 32
  const dim = axis === 'x' ? 'width' : 'height'
  const cross = axis === 'x' ? 'y' : 'x'
  const crossDim = axis === 'x' ? 'height' : 'width'
  const intervals = boxes
    .filter(box => box[cross] < anchor[cross] + node[crossDim] + gap &&
      box[cross] + box[crossDim] > anchor[cross] - gap)
    .map(box => [box[axis] - node[dim] - gap, box[axis] + box[dim] + gap])
    .sort((a, b) => sign > 0 ? a[0] - b[0] : b[1] - a[1])
  let position = sign > 0 ? anchor[axis] + anchor[dim] + gap : anchor[axis] - node[dim] - gap
  for (const [low, high] of intervals) {
    if (position > low && position < high) position = sign > 0 ? high : low
  }
  return {
    x: axis === 'x' ? position : anchor.x,
    y: axis === 'y' ? position : anchor.y,
    distance: sign > 0 ? position - (anchor[axis] + anchor[dim]) : anchor[axis] - (position + node[dim]),
  }
}

async function placeNearSelection(live, page, selection, node) {
  if (!page.children.length) return { x: 0, y: 0 }
  const response = await live.call('snapshot_layout', { pageId: selection.activePageId, maxDepth: 0 })
  const boxes = response.value?.layout
  if (!Array.isArray(boxes) || !boxes.length || boxes.some(box =>
    ![box.x, box.y, box.width, box.height].every(Number.isFinite))) throw fail('canvas_changed')
  const selected = new Set(selection.selectedIds)
  const root = selected.size ? page.children.find(child => containsSelection(child, selected)) : null
  const anchor = boxes.find(box => box.id === root?.id) ?? boxes[0]
  const candidates = [['y', -1], ['x', 1], ['y', 1], ['x', -1]]
    .map(([axis, sign]) => clearPosition(boxes, node, anchor, axis, sign))
  // Stable ties favor the space directly above the anchor. Existing grids
  // typically grow to the right and below, leaving this edge in view.
  const closest = candidates.reduce((best, item) => item.distance < best.distance ? item : best)
  return { x: closest.x, y: closest.y }
}

export async function readCanvasContext(editorHost, options) {
  const { describeCanvasSelection } = await import('./pen-context.mjs')
  try {
    return await editorHost.withCompilerCanvas(options, async live => {
      const [selection, state] = await Promise.all([live.selection(), live.read()])
      const visual = options.visualSelection
      if (visual && visual.sessionId !== live.id) throw fail('canvas_changed')
      const activePageId = visual?.activePageId ?? selection.activePageId
      const page = currentPage(state, activePageId)
      const selectedIds = visual?.selectedIds ?? selection.selectedIds
      const prior = priorNode(page, options.previousFrame, live.id)
      const structure = options.describePage?.(page.children, selectedIds)
      const describe = node => /^pen_[a-f0-9]{64}_/u.test(node.id) && options.summarizeImported
        ? options.summarizeImported(node) : summarize(node)
      return {
        sessionId: live.id,
        activePageId,
        boards: page.children.filter(n => n.type === 'frame').slice(0,48).map(n => ({id:n.id,name:String(n.name ?? '').slice(0,180)})),
        context: {
          pageName: page.name ?? '',
          frames: page.children.slice(0, 32).map(describe),
          selection: describeCanvasSelection(page.children, selectedIds),
          ...(structure ? { designStructure: structure } : {}),
          canRevise: Boolean(prior),
          // The receipt is bound to a tree previously made by this assistant.
          ...(prior ? { previousFrame: prior } : {}),
        },
      }
    })
  } catch (error) {
    throw error.code ? error : fail('canvas_unavailable')
  }
}

export async function applyCanvasFrame(editorHost, frame, options) {
  const { node, count } = cleanFrame(frame)
  replaceAssetSources(node, options.resolveAsset)
  const { snapshot, action, previousFrame } = options
  const revise = action === 'revise'
  if (!revise && action !== 'create') throw fail('invalid_design')
  if (revise && !snapshot.context.canRevise) throw fail('revision_conflict')
  return editorHost.withCompilerCanvas({ ...options, sessionId: snapshot.sessionId }, async live => {
    const [selection, state] = await Promise.all([live.selection(), live.read()])
    const pageId = selection.activePageId
    if (pageId !== snapshot.activePageId) throw fail('canvas_changed')
    const page = currentPage(state, pageId)
    const prior = revise ? priorNode(page, previousFrame, live.id) : undefined
    if (revise && !prior) throw fail('revision_conflict')
    const oldIds = new Set(page.children.map(child => child.id))
    if (prior) {
      node.x = prior.x ?? 0
      node.y = prior.y ?? 0
    } else {
      Object.assign(node, await placeNearSelection(live, page, selection, node))
    }
    options.signal?.throwIfAborted()
    const args = { data: node, pageId }
    if (revise) Object.assign(args, { nodeId: prior.id, node_id: prior.id, drop_children: true })
    // Once the write has begun, finish its bounded native operation and retain
    // the receipt even if the caller switches views or disconnects.
    const commitSignal = AbortSignal.timeout(20000)
    let writeError
    try {
      await live.call(revise ? 'replace_node' : 'insert_node', args, commitSignal)
    } catch (error) {
      // A transport failure may occur after a successful native mutation.
      // Inspect the authoritative state once before treating it as a failure.
      if (!error.uncertain) throw error.code ? error : fail('edit_failed')
      writeError = error
    }
    const receiptSignal = AbortSignal.timeout(7000)
    const next = currentPage(await live.read(receiptSignal), pageId)
    const result = next.children.find(child => child.name === node.name &&
      child.x === node.x && child.y === node.y &&
      (!oldIds.has(child.id) || (revise && child.id === prior.id && fingerprint(child) !== previousFrame.fingerprint)))
    if (!result) throw writeError ?? fail('edit_failed')
    // Selection is optional: the design is already committed, so a focus
    // failure must never report failure and encourage a duplicate insertion.
    await live.call('set_selection', { node_id: result.id }, receiptSignal).catch(() => {})
    return { id: result.id, name: result.name, nodeCount: count, fingerprint: fingerprint(result), sessionId: live.id,
      x:result.x, y:result.y, targetIds:workTargetIds(result) }
  })
}

/**
 * Insert one caller-supplied node, such as an uploaded image, beside the
 * current selection and leave it selected. The project canvas saves the change through its editor lifecycle.
 * @param editorHost - managed editor controller.
 * @param node - clean OpenPencil node with numeric bounds.
 * @param options - canvas binding, asset resolver and cancellation signal.
 * @returns the inserted node identity and bounds.
 */
export async function insertCanvasNode(editorHost, node, options) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) throw fail('invalid_design')
  if (!types.has(node.type)) throw fail('invalid_design')
  if (typeof node.name !== 'string' || node.name.trim() === '' || node.name.length > 240) throw fail('invalid_design')
  for (const key of ['width', 'height']) {
    if (!Number.isFinite(node[key]) || node[key] <= 0) throw fail('invalid_design')
  }
  for (const key of ['x', 'y']) {
    if (node[key] !== undefined && !Number.isFinite(node[key])) throw fail('invalid_design')
  }
  if (node.type === 'image') {
    if (typeof node.src !== 'string') throw fail('invalid_design')
    node.src = replaceOneAsset(node.src, options.resolveAsset)
  }
  return editorHost.withCompilerCanvas(options, async live => {
    const [selection, state] = await Promise.all([live.selection(), live.read()])
    const pageId = selection.activePageId
    const page = currentPage(state, pageId)
    if (node.x === undefined || node.y === undefined) {
      Object.assign(node, await placeNearSelection(live, page, selection, node))
    }
    const oldIds = new Set(page.children.map(child => child.id))
    options.signal?.throwIfAborted()
    await live.call('insert_node', { data: node, pageId }, AbortSignal.timeout(20000))
    const next = currentPage(await live.read(AbortSignal.timeout(7000)), pageId)
    const result = next.children.find(child => !oldIds.has(child.id) && child.name === node.name)
    if (!result) throw fail('edit_failed')
    await live.call('set_selection', { node_id: result.id }, AbortSignal.timeout(7000)).catch(() => {})
    return {
      id: result.id, name: result.name, type: result.type,
      x: result.x, y: result.y, width: result.width, height: result.height,
    }
  })
}

function replaceOneAsset(source, resolveAsset) {
  if (!source.startsWith('asset:')) return source
  const resolved = resolveAsset?.(source.slice(6))
  if (typeof resolved !== 'string') throw fail('invalid_design')
  return resolved
}

// Work areas are placement hints, never real document nodes. Recheck the live
// native bounds when a worker finishes because another writer may arrive first.
export async function prepareAgentWorkAreas(editorHost, count, options) {
  if (!Number.isInteger(count) || count < 1 || count > 6) throw fail('invalid_design')
  const {snapshot} = options
  return editorHost.withCompilerCanvas({...options, sessionId:snapshot.sessionId}, async live => {
    const [selection, state] = await Promise.all([live.selection(), live.read()])
    if (selection.activePageId !== snapshot.activePageId) throw fail('canvas_changed')
    const page = currentPage(state, snapshot.activePageId)
    let x = 0, y = 0
    if (page.children.length) {
      const boxes = await workBounds(live, snapshot.activePageId)
      const ids = new Set(options.visualSelection?.selectedIds ?? selection.selectedIds)
      const root = page.children.find(child => containsSelection(child, ids))
      const anchor = boxes.find(box => box.id === root?.id) ?? boxes[0]
      if (!anchor) throw fail('canvas_changed')
      x = anchor.x
      y = anchor.y + anchor.height + 48
    }
    return Array.from({length:count}, (_, i) => ({index:i+1, x:x+i*352, y}))
  })
}

async function workBounds(live, pageId, extra = {}) {
  const result = await live.call('snapshot_layout', {pageId, maxDepth:0, ...extra})
  const boxes = result?.value?.layout
  if (!Array.isArray(boxes)) throw fail('canvas_changed')
  return boxes.filter(box => [box.x,box.y,box.width,box.height].every(Number.isFinite))
}

export async function resolveAgentWorkTarget(editorHost, targetId, options) {
  if (!targetId || typeof targetId !== 'string') return null
  const {snapshot} = options
  return editorHost.withCompilerCanvas({...options, sessionId:snapshot.sessionId}, async live => {
    const selection = await live.selection()
    if (selection.activePageId !== snapshot.activePageId) return null
    // The native parentId filter excludes the parent itself and resets its
    // origin. A page-root snapshot retains absolute coordinates at every depth.
    const boxes = await workBounds(live, snapshot.activePageId, {maxDepth:24})
    const pending = boxes.map(box => ({box,enclosing:null}))
    while (pending.length) {
      const {box,enclosing} = pending.pop()
      const large = Number.isFinite(box.width*box.height) && box.width*box.height >= 2000
      if (box.id === targetId) return {x:box.x+box.width/2, y:box.y+box.height/2,
        anchorId:large || !enclosing ? targetId : enclosing}
      for (const child of box.children ?? []) pending.push({box:child,enclosing:large ? box.id : enclosing})
    }
    return null
  })
}

function receiptForBoard(expectation, root, includeTargets) {
  const {index, round, boardId, count} = expectation
  const receipt = {index, round, boardId, count, name:root.name}
  if (!includeTargets) return receipt
  return {...receipt, x:root.x, y:root.y, targetIds:workTargetIds(root)}
}

function workTargetIds(root) {
  // Expose a short, ordered path through real, committed layers. The native
  // painter resolves scene geometry, so text, layout, pan and zoom stay aligned.
  const targets = []
  function visit(node) {
    if (targets.length >= 12) return
    targets.push(node.id)
    for (const child of node.children ?? []) visit(child)
  }
  visit(root)
  return targets
}

function freeWorkPosition(boxes, node, hint) {
  const x = hint.x
  let y = hint.y
  // Travel down one column only as far as the existing content requires.
  for (const box of [...boxes].sort((a,b) => a.y-b.y)) {
    if (x < box.x + box.width + 32 && x + node.width + 32 > box.x &&
        y < box.y + box.height + 32 && y + node.height + 32 > box.y) {
      y = box.y + box.height + 32
    }
  }
  return {x,y}
}

// A generated batch has one commit point. The daemon compares the version of
// the exact snapshot being merged; IDs make a retry safe after a lost receipt.
export async function applyParallelFrames(editorHost, designs, options) {
  const { serializeDocument } = await import('./pen-import.mjs')
  const { snapshot } = options
  const prefix = 'uic_batch_' + createHash('sha256').update(options.batchKey).digest('hex') + '_'
  const normalized = designs.map(({frame, index, round}) => {
    const { node, count } = cleanFrame(frame)
    replaceAssetSources(node, options.resolveAsset)
    const boardId = prefix + index + '_v' + (round + 1)
    let serial = 0
    function identify(layer) {
      layer.id = serial ? boardId + '_' + serial : boardId
      serial++
      for (const child of layer.children ?? []) identify(child)
    }
    identify(node)
    const suffix = ' · A' + index + ' V' + (round + 1)
    const baseName = node.name.replace(/(?:\s*·\s*A\d+\s+V\d+\s*)+$/iu, '').trim() || node.name
    node.name = baseName.slice(0, 240 - suffix.length) + suffix
    return {index, round, boardId, node, count}
  })
  return editorHost.withCompilerCanvas({ ...options, sessionId: snapshot.sessionId }, async live => {
    const [selection, state] = await Promise.all([live.selection(), live.read()])
    if (selection.activePageId !== snapshot.activePageId) throw fail('canvas_changed')
    const doc = JSON.parse(state.documentJson)
    const page = doc.pages?.length ? doc.pages.find(p => p.id === snapshot.activePageId) ??
      (/^\d+$/u.test(snapshot.activePageId) ? doc.pages[Number(snapshot.activePageId)] : undefined) : doc
    if (!Array.isArray(page?.children)) throw fail('canvas_changed')
    function existingReceipt(children) {
      const byId = new Map(children.map(n => [n.id, n]))
      const roots = normalized.map(({boardId}) => byId.get(boardId))
      if (!roots.some(Boolean)) return
      if (!roots.every(Boolean)) throw fail('canvas_changed')
      return normalized.map((expected, i) => receiptForBoard(expected, roots[i], options.incremental))
    }
    const retry = existingReceipt(page.children)
    if (retry) return retry
    const remaining = (doc.pages?.length ? doc.pages : [doc]).flatMap(p => p.children)
    while (remaining.length) {
      const item = remaining.pop()
      if (options.incremental
          ? normalized.some(({boardId}) => item.id === boardId || item.id?.startsWith(boardId + '_'))
          : item.id?.startsWith(prefix)) throw fail('canvas_changed')
      for (const child of item.children ?? []) remaining.push(child)
    }
    if (options.incremental) {
      const boxes = page.children.length ? await workBounds(live, snapshot.activePageId) : []
      for (const {index, round, node} of normalized) {
        const workArea = options.workAreas?.find(area => area.index === index)
        if (!workArea || ![workArea.x,workArea.y].every(Number.isFinite)) throw fail('canvas_changed')
        Object.assign(node, freeWorkPosition(boxes, node, {x:workArea.x, y:workArea.y + round*288}))
        boxes.push(node)
        page.children.push(node)
      }
    } else {
      const widths = [], heights = []
      for (const {index, round, node} of normalized) {
        widths[index - 1] = Math.max(widths[index - 1] ?? 0, node.width)
        heights[round] = Math.max(heights[round] ?? 0, node.height)
      }
      const positions = sizes => {
        let offset = 0
        return sizes.map(size => {
          const start = offset
          offset += size + 48
          return start
        })
      }
      const xs = positions(widths), ys = positions(heights)
      const size = { width: xs.at(-1) + widths.at(-1), height: ys.at(-1) + heights.at(-1) }
      const anchor = options.visualSelection?.activePageId === snapshot.activePageId
        ? {...selection, selectedIds: options.visualSelection.selectedIds} : selection
      const origin = await placeNearSelection(live, page, anchor, size)
      for (const {index, round, node} of normalized) {
        node.x = origin.x + xs[index - 1]
        node.y = origin.y + ys[round]
        page.children.push(node)
      }
    }
    options.signal.throwIfAborted()
    let encoded
    try { encoded = serializeDocument(doc) }
    catch { invalid('batch', 'the combined canvas exceeds the native document size limit') }
    let writeError
    try { await live.replaceDocument(encoded, state.version) }
    catch (error) { writeError = error }
    const receiptSignal = AbortSignal.timeout(10000)
    const next = currentPage(await live.read(receiptSignal), snapshot.activePageId)
    const receipt = existingReceipt(next.children)
    if (!receipt) {
      if (/409|version conflict/iu.test(writeError?.message) || writeError?.code === 'canvas_changed') throw fail('canvas_changed')
      throw fail('edit_failed')
    }
    if (!options.incremental) await live.call('set_selection', {node_id: receipt[0].boardId}, receiptSignal).catch(() => {})
    return receipt
  })
}
