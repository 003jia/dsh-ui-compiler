import { readFileSync } from 'node:fs'
import { designStates, type DesignNode, type DesignPage, type DesignWarning } from '../../ir/index.ts'

type Fields = Record<string, unknown>
type VariantValue = string | number | boolean
type OpNode = {
  id: string
  name: string
  type: string
  fields: Fields
  children: OpNode[]
}

const layoutKeys = [
  'layout', 'width', 'height', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight',
  'gap', 'padding', 'alignItems', 'justifyContent', 'clipContent', 'x', 'y',
]
const styleKeys = [
  'fill', 'stroke', 'cornerRadius', 'opacity', 'effect', 'rotation', 'blendMode',
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing',
  'textAlign', 'textAlignVertical', 'textGrowth', 'underline', 'strikethrough',
]

function record(value: unknown): Fields | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Fields : undefined
}

function pick(fields: Fields, keys: readonly string[]): Fields {
  return Object.fromEntries(keys.filter(key => Object.hasOwn(fields, key)).map(key => [key, fields[key]]))
}

function readNodes(value: unknown): OpNode[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('.op children must be an array')
  return value.map(item => {
    const fields = record(item)
    if (!fields || typeof fields.id !== 'string' || !fields.id || typeof fields.type !== 'string') {
      throw new Error('Every .op node must have a non-empty id and a type')
    }
    return {
      id: fields.id,
      name: typeof fields.name === 'string' && fields.name ? fields.name : fields.id,
      type: fields.type,
      fields,
      children: readNodes(fields.children),
    }
  })
}

function visible(name: string, fields: Fields): boolean {
  return !name.startsWith('_') && fields.hidden !== true && fields.visible !== false && fields.enabled !== false
}

function componentName(name: string): string | undefined {
  return /^DSH\/[A-Za-z][\w-]*(?=$|\s|\[|·)/u.exec(name)?.[0]
}

function inlineVariants(name: string): [string, VariantValue][] {
  const attributes = name.match(/\[([^\]]+)\]$/u)?.[1]?.split(',') ?? name.split('·').slice(1)
  return attributes.flatMap<[string, VariantValue]>(attribute => {
    const match = /^\s*([\w-]+)\s*=\s*(.*?)\s*$/u.exec(attribute)
    if (!match || match[2] === '') return []
    const key = match[1]!
    const value = match[2]!
    if (value === 'true' || value === 'false') return [[key, value === 'true']]
    if (/^-?\d+(?:\.\d+)?$/u.test(value)) return [[key, Number(value)]]
    return [[key, value]]
  })
}

function fieldVariants(fields: Fields): [string, VariantValue][] {
  const values = typeof fields.variant === 'string' ? [['variant', fields.variant] as [string, VariantValue]] : []
  for (const source of [fields.variant, fields.variants, fields.componentProperties]) {
    for (const [key, item] of Object.entries(record(source) ?? {})) {
      const value = record(item)?.value ?? item
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        values.push([key, value])
      }
    }
  }
  return values
}

function contentOf(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const segments = content.map(item => {
    if (typeof item === 'string') return item
    const segment = record(item)
    return segment?.text ?? segment?.content
  })
  return segments.every(segment => typeof segment === 'string') ? segments.join('') : undefined
}

function instanceText(master: OpNode, instance: OpNode, warn: (message: string) => void): Record<string, string> {
  const overrides = record(instance.fields.descendants) ?? {}
  const used = new Set<string>()
  const text = new Map<string, string>()

  function visit(node: OpNode, parents: string[]) {
    const path = [...parents, node.id]
    const overrideKey = Object.hasOwn(overrides, path.join('/')) ? path.join('/') : node.id
    const patch = Object.hasOwn(overrides, overrideKey) ? record(overrides[overrideKey]) : undefined
    if (patch) {
      used.add(overrideKey)
      if (Object.keys(patch).some(key => !['content', 'enabled', 'hidden', 'visible'].includes(key))) {
        warn(`Component descendant override ${overrideKey} contains properties outside text binding`)
      }
    }
    const fields = { ...node.fields, ...patch }
    if (!visible(node.name, fields)) return
    if (node.type === 'text') {
      const label = contentOf(fields.content)
      const key = node.name.split('/').at(-1)!
      if (label === undefined) warn(`Component text ${node.id} has unsupported content`)
      else if (text.has(key)) warn(`Component exposes multiple text layers named '${key}'`)
      else text.set(key, label)
    }
    for (const child of node.children) visit(child, path)
  }

  for (const child of master.children) visit(child, [])
  for (const key of Object.keys(overrides).filter(key => !used.has(key))) {
    warn(`Unresolved component descendant override '${key}'`)
  }
  for (const fields of [master.fields, instance.fields]) {
    const label = fields.label ?? record(fields.semantics)?.label
    if (typeof label === 'string' && (fields === instance.fields || !text.has('label'))) text.set('label', label)
    for (const [key, value] of Object.entries(record(fields.text) ?? {})) {
      if (typeof value === 'string') text.set(key, value)
    }
  }
  return Object.fromEntries(text)
}

function plainGroup(node: OpNode, style: Fields, layout: Fields): boolean {
  return node.type === 'group'
    && Object.entries(style).every(([key, value]) => key === 'opacity' && value === 1)
    && Object.entries(layout).every(([key, value]) =>
      (key === 'layout' && value === 'none')
      || ((key === 'x' || key === 'y') && value === 0)
      || (key === 'clipContent' && value === false),
    )
}

export function readOpDocument(file: string, frame: string, options: { nativePreviewLayout?: boolean } = {}): DesignPage {
  let input: unknown
  try {
    input = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`Cannot read .op document ${file}`, { cause: error })
  }
  const document = record(input)
  if (!document) throw new Error('.op document must be an object')
  const pages = document.pages
  if (pages !== undefined && !Array.isArray(pages)) throw new Error('.op pages must be an array')
  const roots = pages?.length ? pages.flatMap(page => {
    const data = record(page)
    if (!data) throw new Error('.op page must be an object')
    return readNodes(data.children)
  }) : readNodes(document.children)

  const byId = new Map<string, OpNode>()
  function index(node: OpNode) {
    if (byId.has(node.id)) throw new Error(`Duplicate .op node ID '${node.id}'`)
    byId.set(node.id, node)
    node.children.forEach(index)
  }
  roots.forEach(index)

  const warnings: DesignWarning[] = []
  function normalize(node: OpNode): DesignNode[] {
    const { id, name, type, fields } = node
    if (!visible(name, fields)) return []
    const style = pick(fields, styleKeys)
    const base = { id, name, style }
    const warn = (message: string) => warnings.push({ id, name, message })
    function unmapped(reason: string): DesignNode[] {
      function omitted(child: OpNode) {
        if (!visible(child.name, child.fields)) return
        warnings.push({ id: child.id, name: child.name, message: `Unsupported parent '${id}' hides this descendant from compilation` })
        child.children.forEach(omitted)
      }
      node.children.forEach(omitted)
      return [{ kind: 'unmapped', ...base, reason }]
    }

    if (type === 'ref') {
      const ref = typeof fields.ref === 'string' ? fields.ref : ''
      const master = byId.get(ref)
      if (!master) return unmapped(`Unresolved component reference '${ref}'`)
      const component = componentName(master.name)
      if (!component || master.type === 'ref') return unmapped(`Unsupported component master '${master.name}' (${ref})`)
      if (node.children.length) warn('Component instance has nested children outside the supported text overrides')
      return [{
        kind: 'instance', ...base, style: { ...style, ...pick(fields, ['width', 'height']) }, component,
        variants: Object.fromEntries([
          ...inlineVariants(master.name), ...fieldVariants(master.fields),
          ...inlineVariants(name), ...fieldVariants(fields),
        ]),
        text: instanceText(master, node, warn),
      }]
    }

    if (type === 'text_input') {
      const variants = Object.fromEntries(fieldVariants(fields))
      if (typeof fields.disabled === 'boolean') variants.disabled = fields.disabled
      const text = new Map<string, string>()
      for (const key of ['placeholder', 'value']) {
        if (typeof fields[key] === 'string') text.set(key, fields[key])
      }
      return [{
        kind: 'instance', ...base, style: { ...style, ...pick(fields, ['width', 'height']) },
        component: 'DSH/Input', variants, text: Object.fromEntries(text),
      }]
    }

    if (type === 'text') {
      const text = contentOf(fields.content)
      if (text === undefined && fields.content !== undefined) return unmapped('Unsupported text content')
      if (Array.isArray(fields.content)) warn('Rich text is compiled as plain text')
      const binding = /^\{([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\}$/u.exec(name)?.[1]
      return [{
        kind: 'text', ...base, style: { ...style, ...pick(fields, ['width', 'height']) }, text: text ?? '',
        ...(binding ? { binding } : {}),
      }]
    }

    if (options.nativePreviewLayout && type === 'ellipse' && typeof fields.width === 'number' && typeof fields.height === 'number') {
      return [{ kind: 'stack', ...base, style: { ...style, cornerRadius: Math.max(fields.width, fields.height) / 2 },
        layout: pick(fields, layoutKeys), children: [] }]
    }
    if (type === 'frame' || type === 'group' || type === 'rectangle') {
      const layout = pick(fields, layoutKeys)
      const children = node.children.flatMap(normalize)
      const repeat = /^([A-Za-z_$][\w$]*)\[\]$/u.exec(name)?.[1]
      if (!repeat && plainGroup(node, style, layout)) return children
      return [{ kind: 'stack', ...base, layout, children, ...(repeat ? { repeat } : {}) }]
    }

    if (type === 'icon_font' || type === 'image') {
      const asset = type === 'image' ? 'image' : 'icon'
      const ref = asset === 'icon' ? fields.iconFontName : fields.src ?? fields.url
      if (typeof ref !== 'string' || !ref) return unmapped(`Missing ${asset} reference`)
      return [{ kind: 'asset', ...base, style: { ...style, ...pick(fields, ['width', 'height']) }, asset, ref }]
    }

    return unmapped(`Unsupported .op node type '${type}'`)
  }

  const visibleFrames = roots.filter(node => node.type === 'frame' && visible(node.name, node.fields))
  const explicitState = designStates.find(state => frame.endsWith(`/${state}`))
  const matches = explicitState
    ? [{ state: explicitState, candidates: visibleFrames.filter(node => node.name === frame) }]
    : designStates.map(state => ({
      state,
      candidates: visibleFrames.filter(node => node.name === `${frame}/${state}` || (state === 'default' && node.name === frame)),
    }))
  const frames = matches.flatMap(({ state, candidates }) => {
    if (candidates.length > 1) throw new Error(`Ambiguous .op frame '${frame}' for state '${state}'`)
    const candidate = candidates[0]
    return candidate ? [{ state, node: normalize(candidate)[0]! }] : []
  })
  if (!frames.length) throw new Error(`Visible .op frame '${frame}' not found; available: ${visibleFrames.map(node => node.name).join(', ')}`)

  return { frames, variables: record(document.variables) ?? {}, warnings }
}
