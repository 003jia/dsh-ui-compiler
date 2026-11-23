// Select only design fields intended for a reader. Never serialize an imported
// node wholesale: paints can embed megabytes of image data and file metadata.
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
const sizeOf = value => Buffer.byteLength(JSON.stringify(value))
const layerTypes = new Set(['frame', 'group', 'rectangle', 'ellipse', 'line', 'polygon', 'path', 'text', 'ref',
  'image', 'icon_font', 'vector', 'note', 'prompt', 'context'])
const typeOf = node => layerTypes.has(node.type) ? node.type : 'other'

function label(value, limit = 120) {
  if (typeof value !== 'string') return undefined
  const cleaned = value.slice(0, limit + 128)
    .replace(/(?:data:|file:\/\/|(?:\/(?:Users|home|private|var|tmp|Volumes|opt|etc)\/|~\/|\b[a-z]:[\\/]))\S*/giu, ' …')
    .replace(/[a-zA-Z0-9+/]{80,}={0,2}/gu, '…')
    .replace(/\s+/gu, ' ').trim()
  return cleaned.length > limit ? cleaned.slice(0, limit - 1) + '…' : cleaned || undefined
}

function dimension(value) {
  if (Number.isFinite(value)) return value
  return typeof value === 'string' && /^(?:fit_content|fill_container)(?:\(-?[\d.]+\))?$/u.test(value) ? value : undefined
}

function paint(value) {
  if (Array.isArray(value)) return paint(value[0])
  const raw = typeof value === 'string' ? value : value?.color
  const color = typeof raw === 'string' ? raw.replace(/^\$pen_[a-f0-9]{64}_/u, '$') : undefined
  return typeof color === 'string' && /^(?:#[a-f\d]{3,8}|\$[\p{L}\d_.-]+)$/iu.test(color) ? label(color, 64) : undefined
}

function textOf(node) {
  if (node.type !== 'text') return undefined
  if (typeof node.content === 'string') return label(node.content, 200)
  if (Array.isArray(node.content)) {
    const parts = node.content.slice(0, 20).map(run => run?.text ?? run?.content)
    return label(parts.filter(part => typeof part === 'string').map(part => part.slice(0, 328)).join(''), 200)
  }
}

function searchTerms(query) {
  const words = [...segmenter.segment(String(query).slice(0, 2000).normalize('NFKC').toLowerCase())]
    .filter(part => part.isWordLike && part.segment.length > 1).map(part => part.segment)
  return [...new Set(words)].slice(0, 48)
}

function ordinal(value) {
  if (/^\d+$/u.test(value)) return Number(value)
  const digits = '零一二三四五六七八九'
  const units = { 十: 10, 百: 100, 千: 1000 }
  let total = 0
  let last = 0
  for (const char of value.replaceAll('两', '二').replaceAll('〇', '零')) {
    if (Object.hasOwn(units, char)) {
      total += (last || 1) * units[char]
      last = 0
    } else last = digits.indexOf(char)
  }
  return total + last
}

function requestedBoards(query, count) {
  const result = new Set()
  const ordinals = /(倒数第?|第)\s*([\d零〇一二两三四五六七八九十百千]+)\s*(?:张|个|块|页|幅|画板)|(?:board|frame|画板)\s*#?\s*(\d+)/giu
  for (const match of String(query).matchAll(ordinals)) {
    const n = ordinal(match[2] ?? match[3])
    result.add(match[1]?.startsWith('倒数') ? count - n + 1 : n)
  }
  if (/最后(?:的)?一?(?:张|个|页|幅|块|画板)|last (?:artboard|frame|board)/iu.test(query)) result.add(count)
  return result
}

function matchScore(terms, value) {
  const haystack = (value || '').normalize('NFKC').toLowerCase()
  return terms.reduce((score, word) => score + (haystack.includes(word) ? 1 : 0), 0)
}

function* walk(root) {
  const stack = [{ node: root, at: '1' }]
  while (stack.length) {
    const visit = stack.pop()
    yield visit
    const children = visit.node.children
    if (Array.isArray(children)) {
      for (let i = children.length - 1; i >= 0; i--) {
        stack.push({ node: children[i], at: visit.at + '.' + (i + 1) })
      }
    }
  }
}

export function summarizeImportedNode(node) {
  return { name: label(node.name), type: typeOf(node), width: dimension(node.width), height: dimension(node.height) }
}

/** Native selection summaries omit text and can lag a rename during save. Resolve
 * only currently selected IDs against the same page snapshot used for this turn. */
export function describeCanvasSelection(children, selectedIds) {
  const ids = [...new Set(selectedIds.slice(0, 12))]
  if (!ids.length) return []
  const wanted = new Set(ids)
  const found = new Map()
  const pending = [...children]
  while (pending.length && found.size < ids.length) {
    const node = pending.pop()
    if (wanted.has(node.id)) found.set(node.id, { ...summarizeImportedNode(node), text: textOf(node) })
    for (const child of node.children ?? []) pending.push(child)
  }
  return ids.filter(id => found.has(id)).map(id => found.get(id))
}

function layerSummary(node, at, components) {
  return {
    at, type: typeOf(node), name: label(node.name), text: textOf(node),
    width: dimension(node.width), height: dimension(node.height),
    layout: label(node.layout, 24), fill: paint(node.fill), gap: dimension(node.gap), radius: dimension(node.cornerRadius),
    component: node.type === 'ref' ? components.get(node.ref) : undefined,
    fontSize: dimension(node.fontSize), icon: label(node.icon ?? node.iconFontName, 48),
  }
}

/** Index top-level boards and expand the most relevant layers within a fixed
 * byte budget. The visible copy and layer tree of a late board are searchable
 * even when an earlier board contains thousands of layers. */
export function describePenStructure(children, query, selectedIds = [], byteBudget = 24 * 1024) {
  const terms = searchTerms(query)
  const selected = new Set(selectedIds)
  const asksAboutSelection = /选中|选区|当前|这个|selected|selection|this (?:board|frame)/iu.test(query)
  const requested = requestedBoards(query, children.length)
  const counts = new Map()
  const components = new Map()
  let totalLayers = 0
  const boards = children.map((root, index) => {
    const name = label(root.name)
    let descendantScore = 0
    let layerCount = 0
    let includesSelection = false
    for (const { node } of walk(root)) {
      layerCount++
      const type = typeOf(node)
      counts.set(type, (counts.get(type) || 0) + 1)
      if (node.reusable === true && node.id) components.set(node.id, label(node.name))
      if (selected.has(node.id)) includesSelection = true
      descendantScore = Math.max(descendantScore, matchScore(terms, (label(node.name) || '') + ' ' + (textOf(node) || '')))
    }
    totalLayers += layerCount
    const summary = { number: index + 1, ...summarizeImportedNode(root), layers: layerCount }
    const titleScore = matchScore(terms, name)
    const score = (requested.has(index + 1) ? 1000 : 0) + titleScore * 8 + descendantScore + (includesSelection ? (asksAboutSelection ? 100 : 2) : 0)
    return { summary, score, root }
  })
  const ranked = [...boards].sort((a, b) => b.score - a.score)
  const focus = ranked.slice(0, 3)
  const share = Math.max(0, Math.floor((byteBudget - 1024) / 2))
  let left = share
  const index = []
  // Prioritize requested boards when the full directory cannot fit.
  for (const board of [...focus, ...boards.filter(b => !focus.includes(b))]) {
    const size = sizeOf(board.summary) + 1
    if (size > left) continue
    index.push(board.summary)
    left -= size
  }
  index.sort((a, b) => a.number - b.number)
  const strongest = focus.length > 1 && focus[0].score > focus[1].score
  const detail = focus.map(({ summary, root }, index) => {
    const portion = strongest ? (index === 0 ? 0.7 : 0.3 / (focus.length - 1)) : 1 / focus.length
    let budget = Math.floor(share * portion)
    const rankedLayers = Array.from(walk(root), ({ node, at }, order) => {
      const layer = layerSummary(node, at, components)
      const score = matchScore(terms, (layer.name || '') + ' ' + (layer.text || ''))
      return { layer, order, score: order === 0 ? Infinity : score + (selected.has(node.id) ? 100 : 0) }
    }).sort((a, b) => b.score - a.score || a.order - b.order)
    const chosen = []
    for (const candidate of rankedLayers) {
      const size = sizeOf(candidate.layer) + 1
      if (size > budget) continue
      chosen.push(candidate)
      budget -= size
    }
    chosen.sort((a, b) => a.order - b.order)
    return { board: summary.number, omittedLayers: summary.layers - chosen.length, layers: chosen.map(item => item.layer) }
  })
  return { topLevelCount: boards.length, totalLayers, layerTypes: Object.fromEntries(counts),
    omittedFromIndex: boards.length - index.length, index, detail }
}

/** Read the live, editable copies of imported artboards on the active page. */
export function describeImportedPage(children, selectedIds, query) {
  const imported = []
  const pending = [...children].reverse()
  while (pending.length) {
    const node = pending.pop()
    if (/^pen_[a-f0-9]{64}_/u.test(node.id)) imported.push(node)
    else if (Array.isArray(node.children)) {
      for (let i = node.children.length - 1; i >= 0; i--) pending.push(node.children[i])
    }
  }
  return imported.length ? describePenStructure(imported, query, selectedIds, 18 * 1024) : undefined
}

/** Include bounded design tokens, resolving scalar values only. */
export function describePenVariables(variables) {
  const entries = Object.entries(variables ?? {})
  let budget = 2048
  const values = []
  for (const [key, definition] of entries) {
    if (!definition || !['color', 'string', 'number', 'boolean'].includes(definition.type)) continue
    const raw = definition.value
    const value = definition.type === 'color' ? paint(raw)
      : typeof raw === 'string' ? label(raw, 72)
      : typeof raw === 'boolean' || Number.isFinite(raw) ? raw : undefined
    const item = { name: label(key, 48), type: definition.type, value }
    const size = sizeOf(item) + 1
    if (size > budget) break
    values.push(item)
    budget -= size
  }
  return { count: entries.length, values }
}
