import { createHash } from 'node:crypto'

function fail(code) {
  return Object.assign(new Error(code), { code })
}

const fingerprint = node => createHash('sha256').update(JSON.stringify(node)).digest('hex')

// The installed host owns the live session and its private operation queue.
// Bind only these local design operations to that queue, including stale-editor
// and on-disk source checks. Model output cannot choose a tool or a file.
export function patchCanvasEditorHost(source) {
  if (createHash('sha256').update(source).digest('hex') !==
      'afead6655bb1de2c76ba61c15644bb2b20403e3e16a42be939b4cc64c652e56f') {
    throw new Error('Unexpected OpenPencil editor host version')
  }
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
            const call = async (tool, args, signal = options.signal) => {
                if (!['insert_node', 'replace_node', 'set_selection', 'snapshot_layout'].includes(tool)) throw new Error('Unsupported canvas operation');
                if (tool === 'insert_node' || tool === 'replace_node') {
                    if (sha256(await readSourceDocument(session.sourcePath)) !== session.baselineSha256) {
                        throw Object.assign(new Error('Source changed'), {code: 'canvas_changed'});
                    }
                }
                return callOpenPencilMcp({baseUrl, token: session.daemonToken, tool, arguments: args, signal});
            };
            session.createdAt = Date.now();
            return operation({id: session.id, read, selection, call});
        });
    }
` + anchor)
}

const types = new Set(['frame', 'text', 'rectangle', 'ellipse'])
const typeAliases = { group: 'frame', container: 'frame', artboard: 'frame', rect: 'rectangle', circle: 'ellipse', label: 'text' }
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
    if (!types.has(type)) invalid(path + '.type', 'use frame, text, rectangle, or ellipse')
    const node = { type }
    const values = { ...raw }
    values.fill ??= type === 'text' ? raw.color ?? raw.textColor ?? raw.fills : raw.backgroundColor ?? raw.background ?? raw.fills
    values.name ??= raw.title
    values.layout ??= raw.layoutMode ?? raw.flexDirection
    values.gap ??= raw.itemSpacing
    values.cornerRadius ??= raw.borderRadius
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
  return { node, count }
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
  try {
    return await editorHost.withCompilerCanvas(options, async live => {
      const [selection, state] = await Promise.all([live.selection(), live.read()])
      const page = currentPage(state, selection.activePageId)
      const prior = priorNode(page, options.previousFrame, live.id)
      return {
        sessionId: live.id,
        activePageId: selection.activePageId,
        context: {
          pageName: page.name ?? '',
          frames: page.children.slice(0, 32).map(summarize),
          selection: selection.nodes.slice(0, 12).map(summarize),
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
    return { id: result.id, name: result.name, nodeCount: count, fingerprint: fingerprint(result), sessionId: live.id }
  })
}
