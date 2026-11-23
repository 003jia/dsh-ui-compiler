// Pencil's editable JSON uses a different paint and layout vocabulary from the
// canonical .op schema. Keep this module pure so the Agent and importer share
// the same parser without granting a drawing access to files or the network.
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype'])
const fail = message => Object.assign(new Error(message), { code: 'invalid_pen' })
const list = value => value == null ? [] : Array.isArray(value) ? value : [value]
const MAX_BYTES = 32 * 1024 * 1024

export function parsePenDocument(bytes) {
  let source
  try {
    if (typeof bytes === 'string') {
      if (Buffer.byteLength(bytes) > MAX_BYTES) throw fail('.pen 文件过大')
      source = bytes.replace(/^\uFEFF/u, '')
    } else {
      if (!(bytes instanceof Uint8Array || bytes instanceof ArrayBuffer)) throw fail('无效的 .pen 文件内容')
      if (bytes.byteLength > MAX_BYTES) throw fail('.pen 文件过大')
      source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    }
  } catch (error) {
    if (error.code === 'invalid_pen') throw error
    throw fail('.pen 必须是 UTF-8 文本')
  }
  let doc
  try { doc = JSON.parse(source) } catch { throw fail('.pen 文件不是有效的 JSON') }
  if (!isRecord(doc) || !/^2(?:\.\d+){0,2}$/u.test(String(doc.version)) || !Array.isArray(doc.children)) {
    throw fail('需要含有 children 的 Pencil 2.x 设计稿')
  }
  if ((doc.variables != null && !isRecord(doc.variables)) || (doc.themes != null && !isRecord(doc.themes))) {
    throw fail('.pen 的变量或主题格式有误')
  }
  const parsed = { version: String(doc.version), children: doc.children, variables: doc.variables ?? {}, themes: doc.themes ?? {} }
  // Bound depth for all values, including overrides, before any recursive pass.
  const stack = [[parsed, 0]]
  for (let entries = 0; stack.length;) {
    const [value, depth] = stack.pop()
    if (++entries > 1_000_000 || depth > 220) throw fail('.pen 的内容过多或嵌套过深')
    if (typeof value === 'number' && !Number.isFinite(value)) throw fail('.pen 含有无效数值')
    if (!value || typeof value !== 'object') continue
    for (const [key, item] of Object.entries(value)) {
      if (forbiddenKeys.has(key)) throw fail('.pen 含有无效的字段名')
      if (key === 'fileToken') delete value[key]
      else stack.push([item, depth + 1])
    }
  }
  const ids = new Set()
  const pending = [...parsed.children]
  while (pending.length) {
    const node = pending.pop()
    if (!isRecord(node) || typeof node.id !== 'string' || !node.id || forbiddenKeys.has(node.id) || node.id.includes('/') ||
        typeof node.type !== 'string' || !node.type || ids.has(node.id) ||
        (node.children != null && !Array.isArray(node.children))) {
      throw fail('.pen 图层缺少有效的唯一 ID、类型或子图层列表')
    }
    ids.add(node.id)
    if (ids.size > 50_000) throw fail('.pen 的图层过多')
    for (const child of node.children ?? []) pending.push(child)
  }
  return parsed
}

function relativeImage(source) {
  if (typeof source !== 'string' || !source || source.length > 1024 ||
      /[:\\%?#\u0000-\u001f\u007f]/u.test(source) || source.startsWith('/')) return
  const parts = source.replace(/^(\.\/)+/u, '').split('/')
  if (parts.some(part => !part || part === '.' || part === '..')) return
  return parts.join('/')
}

export function referencedPenImages(parsed) {
  const paths = new Set()
  function collect(value) {
    if (!value || typeof value !== 'object') return
    if (value.type === 'image') {
      for (const source of [value.url, value.src]) {
        const path = relativeImage(source)
        if (path) paths.add(path)
      }
    }
    for (const child of Object.values(value)) collect(child)
  }
  collect(parsed.children)
  return [...paths]
}

const nativeTypes = new Set(['frame', 'group', 'rectangle', 'ellipse', 'line', 'polygon', 'path', 'text', 'ref', 'image', 'icon_font'])
const scalarFields = new Set(('name x y rotation opacity flipX flipY visible locked reusable ' +
  'width height minWidth minHeight maxWidth maxHeight layout gap padding margin alignItems justifyContent ' +
  'clipContent layoutPosition blendMode cornerRadius fontFamily fontSize fontWeight ' +
  'fontStyle textGrowth textAlign textAlignVertical letterSpacing lineHeight underline strikethrough ' +
  'iconFontName iconFontFamily iconFontWeight fillRule d polygonCount innerRadius startAngle sweepAngle').split(' '))
const weights = { normal: 400, regular: 400, thin: 100, light: 300, medium: 500, semibold: 600, bold: 700, black: 900 }
const dataImage = value => typeof value === 'string' && /^data:image\/(?:png|jpeg|gif|webp|avif);base64,[a-z\d+/]+={0,2}$/iu.test(value)

export function convertPenDocument(parsed, { namespace = '', assets = new Map() } = {}) {
  if (typeof namespace !== 'string' || !/^[a-z\d_-]*$/iu.test(namespace)) throw fail('无效的导入命名空间')
  const warnings = new Set()
  const missingAssets = new Set()
  const byId = new Map()
  let embeddedImageBytes = 0
  let nodeCount = 0
  function index(node) {
    byId.set(node.id, node)
    for (const child of node.children ?? []) index(child)
  }
  parsed.children.forEach(index)
  const prefixed = key => namespace + key
  const variable = v => typeof v === 'string' && v.startsWith('$') && Object.hasOwn(parsed.variables, v.slice(1))
    ? '$' + prefixed(v.slice(1)) : v
  const theme = values => Object.fromEntries(Object.entries(values ?? {}).map(([k, v]) => [prefixed(k), v]))
  const themes = theme(parsed.themes)
  const variables = {}
  for (const [key, def] of Object.entries(parsed.variables)) {
    if (!isRecord(def) || !['number', 'string', 'color', 'boolean'].includes(def.type)) {
      warnings.add('已略过不支持的变量类型')
      continue
    }
    const val = def.value
    const scalar = value => ['string','number','boolean'].includes(typeof value)
    if (!(scalar(val) || (Array.isArray(val) && val.every(e => isRecord(e) && scalar(e.value))))) {
      throw fail('.pen 变量值格式有误')
    }
    variables[prefixed(key)] = { type: def.type, value: Array.isArray(val)
      ? val.map(e => ({ value: variable(e.value), ...(e.theme ? { theme: theme(e.theme) } : {}) })) : variable(val) }
  }
  function embed(data) {
    embeddedImageBytes += data.length
    if (embeddedImageBytes > 48 * 1024 * 1024) throw fail('内嵌图片总量超过可导入大小')
    return data
  }
  function image(source) {
    if (dataImage(source)) return embed(source)
    const path = relativeImage(source)
    if (path) {
      const data = assets.get(path)
      if (dataImage(data)) return embed(data)
      missingAssets.add(path)
      warnings.add('缺少引用图片，已保留对应图层')
    } else if (source) warnings.add('外部或不支持的图片地址已略过，已保留对应图层')
    return ''
  }
  function paint(v) {
    if (typeof v === 'string') return { type: 'solid', color: variable(v) }
    if (!isRecord(v) || v.enabled === false) return
    const common = {}
    for (const key of ['opacity','blendMode']) if (v[key] != null) common[key] = variable(v[key])
    if (v.type === 'color' || v.type === 'solid') return { ...common, type: 'solid', color: variable(v.color) }
    if (v.type === 'image') {
      const url = image(v.url ?? v.src)
      if (url) return { ...common, type: 'image', url, mode: ({ cover:'fill', contain:'fit' })[v.mode] ??
        (['fill','fit','crop','stretch','tile'].includes(v.mode) ? v.mode : 'fill') }
      return
    }
    const kind = v.type === 'gradient' ? v.gradientType : String(v.type).replace('_gradient','')
    if (kind === 'linear' || kind === 'radial') {
      const stops = list(v.colors ?? v.stops).map(stop => {
        if (!isRecord(stop) || typeof stop.color !== 'string') throw fail('.pen 渐变色标格式有误')
        return { offset: stop.position ?? stop.offset ?? 0, color: variable(stop.color) }
      })
      if (v.size && (v.size.width != null && v.size.width !== 1 || v.size.height != null && v.size.height !== 1)) {
        warnings.add('渐变的自定义缩放已采用编辑器默认值')
      }
      return { ...common, type: kind + '_gradient', ...(kind === 'linear' ? {angle: v.rotation ?? v.angle ?? 0} : {}), stops }
    }
    warnings.add('已略过不支持的填充类型')
  }
  const paints = value => list(value).map(paint).filter(Boolean)
  function effect(v) {
    if (!isRecord(v) || v.enabled === false) return
    if (v.type === 'shadow') return { type:'shadow', inner: v.shadowType === 'inner' || v.inner === true,
      offsetX: v.offset?.x ?? v.offsetX ?? 0, offsetY: v.offset?.y ?? v.offsetY ?? 0,
      blur: v.blur ?? 0, spread: v.spread ?? 0, color: variable(v.color ?? '#000000') }
    if (['blur','background_blur'].includes(v.type)) return {type: v.type, radius: v.radius ?? v.blur ?? 0}
    warnings.add('已略过不支持的图层效果')
  }
  function numberVar(v) {
    if (typeof v !== 'string') return v
    let value = v
    const visited = new Set()
    while (typeof value === 'string' && value.startsWith('$') && !visited.has(value)) {
      visited.add(value)
      const def = parsed.variables[value.slice(1)]?.value
      value = Array.isArray(def) ? def[0]?.value : def
    }
    warnings.add('圆角或多边内距中的数值变量已按当前值导入')
    return typeof value === 'number' ? value : 0
  }
  function stroke(v, width) {
    const obj = isRecord(v) && !v.type ? v : {fill:v}
    const out = { thickness: obj.thickness ?? width ?? 1, fill: paints(obj.fill) }
    for (const k of ['align','join','cap','dashPattern','miterLimit']) if (obj[k] != null) out[k] = obj[k]
    return out
  }
  function content(v) {
    if (typeof v === 'string') return variable(v)
    if (!Array.isArray(v)) return ''
    return v.map(segment => {
      if (typeof segment === 'string') return {text: segment}
      if (!isRecord(segment)) throw fail('.pen 富文本片段格式有误')
      const result = {text: String(segment.text ?? segment.content ?? '')}
      for (const k of ['fontFamily','fontSize','fontStyle','underline','strikethrough','letterSpacing']) {
        if (segment[k] != null) result[k] = variable(segment[k])
      }
      if (segment.fontWeight != null) result.fontWeight = weights[segment.fontWeight] ?? (Number(segment.fontWeight) || 400)
      if (segment.fill != null) {
        const color = paints(segment.fill).find(f => f.type === 'solid')?.color
        if (color) result.fill = color
      }
      return result
    })
  }
  function properties(node) {
    const out = {}
    for (const [key,value] of Object.entries(node)) {
      if (value == null) continue
      if (key === 'fill') out.fill = paints(value)
      else if (key === 'stroke') out.stroke = stroke(value, node.strokeWidth)
      else if (key === 'effect' || key === 'effects') out.effects = list(value).map(effect).filter(Boolean)
      else if (key === 'content') out.content = content(value)
      else if (key === 'theme') out.theme = theme(value)
      else if (key === 'enabled') out.enabled = variable(value)
      else if (key === 'clip') out.clipContent = value
      else if (key === 'layoutPosition') {
        if (value === 'absolute') out.constraints = {h:'left', v:'top'}
      } else if (key === 'cornerRadius') out.cornerRadius = Array.isArray(value) ? value.map(numberVar) : numberVar(value)
      else if (key === 'geometry') out.d = value
      else if (key === 'icon') out.iconFontName = value
      else if (key === 'library') out.iconFontFamily = value
      else if (key === 'slot' && Array.isArray(value)) out.slot = value.map(prefixed)
      else if (key === 'fontWeight') out.fontWeight = weights[value] ?? (Number(value) || value)
      else if (key === 'padding' && Array.isArray(value)) out.padding = value.map(numberVar)
      else if (scalarFields.has(key)) out[key] = key === 'name' ? value : variable(value)
      else if (!['id','type','children','ref','descendants','strokeWidth','src','url','objectFit'].includes(key)) {
        warnings.add('已略过不支持的字段：' + key.slice(0, 80))
      }
    }
    return out
  }
  const refProps = new Set(['id','type','name','x','y','rotation','opacity','visible','enabled','locked','flipX','flipY','theme','constraints','blendMode'])
  function instance(out, node) {
    if (!byId.has(node.ref)) throw fail('.pen 的组件实例引用了未包含的主组件')
    out.ref = prefixed(node.ref)
    const overrides = {}
    for (const [path, patch] of Object.entries(node.descendants ?? {})) {
      if (!isRecord(patch)) throw fail('.pen 的实例覆盖属性格式有误')
      const chain = path.split('/')
      if (chain.some(key => !byId.has(key))) {
        warnings.add('已略过未找到目标图层的组件覆盖')
        continue
      }
      // OpenPencil matches descendant overrides by the original child's ID.
      // Nested component instances each own their own descendants dictionary.
      let dest = overrides
      for (const id of chain.slice(0,-1)) {
        if (byId.get(id)?.type !== 'ref') continue
        const entry = dest[prefixed(id)] ??= {}
        dest = entry.descendants ??= {}
      }
      const key = prefixed(chain.at(-1))
      const values = properties(patch)
      if (patch.ref && byId.has(patch.ref)) values.ref = prefixed(patch.ref)
      if (patch.children || patch.type) warnings.add('组件实例的替换型图层覆盖只保留可编辑属性')
      dest[key] = { ...dest[key], ...values }
    }
    // Canonical RefNode stores size and paints in descendants[masterId].
    // Direct fill/width on a RefNode would disappear at the first save.
    for (const [k,v] of Object.entries(out)) {
      if (k === 'ref' || refProps.has(k)) continue
      const root = overrides[out.ref] ??= {}
      root[k] = v
      delete out[k]
    }
    if (Object.keys(overrides).length) out.descendants = overrides
  }
  function convert(node) {
    nodeCount++
    const type = node.type === 'icon' ? 'icon_font' : node.type === 'prompt' || node.type === 'note' ? 'text' : node.type
    const out = { type, id: prefixed(node.id), ...properties(node) }
    if (!nativeTypes.has(type)) {
      out.type = 'frame'
      out.layout ??= 'none'
      warnings.add('已将不支持的图层类型转为可编辑容器：' + type.slice(0,80))
    }
    if (out.type === 'ref') instance(out,node)
    if (out.type === 'frame') out.layout ??= 'horizontal'
    if (out.type === 'frame' || out.type === 'text' || out.type === 'group') {
      out.width ??= 'fit_content'
      out.height ??= 'fit_content'
    }
    if (out.type === 'text') out.content ??= ''
    if (out.type === 'icon_font') out.iconFontName ??= ''
    if (out.type === 'polygon') out.polygonCount ??= 3
    if (out.type === 'path') out.d ??= ''
    if (out.type === 'image') {
      out.src = image(node.src ?? node.url)
      const fit = {cover: 'fill', contain: 'fit', stretch: 'fill'}[node.objectFit] ?? node.objectFit
      if (['fill','fit','crop','tile'].includes(fit)) out.objectFit = fit
    }
    if (node.children) out.children = node.children.map(convert)
    return out
  }
  const children = parsed.children.map(convert)
  return {children, variables, themes, boardCount: children.length, nodeCount,
    warnings: [...warnings], missingAssets: [...missingAssets]}
}
