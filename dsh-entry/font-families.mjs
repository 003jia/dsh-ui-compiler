/** Collect real typefaces and the exact $names the editor may request for them.
 * Reads an .op (or portable .pen) without rewriting its design variables. Keep
 * this function self-contained so the web editor can use the same resolver. */
export function collectCanvasFontFamilies(doc, supported, activeTheme = {}) {
  const families = new Set()
  const aliases = new Map()
  const variables = doc?.variables ?? {}
  const resolvedByTheme = new WeakMap()
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)

  function themeValue(value, theme) {
    if (!Array.isArray(value)) return value
    // Match OpenPencil's resolve_value: first matching axes, then the unthemed
    // entry, then the first entry when every variant is themed.
    const entry = value.find(item => record(item?.theme) &&
      Object.entries(item.theme).every(([k, v]) => Object.hasOwn(theme, k) && theme[k] === v)) ??
      value.find(item => item && item.theme == null) ?? value[0]
    return entry?.value
  }

  function resolve(name, theme) {
    let cache = resolvedByTheme.get(theme)
    if (!cache) resolvedByTheme.set(theme, cache = new Map())
    const chain = new Set()
    let value = name
    while (typeof value === 'string' && value.startsWith('$')) {
      if (cache.has(value)) {
        value = cache.get(value)
        break
      }
      if (chain.has(value)) {
        value = undefined
        break
      }
      chain.add(value)
      const key = value.slice(1)
      const def = Object.hasOwn(variables, key) ? variables[key] : undefined
      value = def?.type === 'string' ? themeValue(def.value, theme) : undefined
    }
    const family = typeof value === 'string' ? value.trim() || undefined : undefined
    for (const key of chain) cache.set(key, family)
    return family
  }

  function add(name, theme) {
    if (typeof name !== 'string' || !name.trim()) return
    if (!name.startsWith('$')) {
      families.add(name.trim())
      return
    }
    const family = resolve(name, theme)
    if (family) families.add(family)
    // An editor-wide font alias cannot represent two different typefaces in
    // two simultaneous node themes. Keep both real faces in that case.
    if (!aliases.has(name)) aliases.set(name, family)
    else if (aliases.get(name) !== family) aliases.set(name, undefined)
  }

  const pending = []
  const initialTheme = record(activeTheme) ? activeTheme : {}
  const pages = Array.isArray(doc?.pages) && doc.pages.length ? doc.pages : [doc]
  for (const page of pages) {
    const theme = record(page?.theme) ? { ...initialTheme, ...page.theme } : initialTheme
    if (Array.isArray(page?.children)) for (const node of page.children) pending.push({ node, theme })
  }
  while (pending.length) {
    const { node, theme: inherited, override } = pending.pop()
    if (!record(node)) continue
    const theme = record(node.theme) ? { ...inherited, ...node.theme } : inherited
    if (node.type === 'text' || override) {
      add(node.fontFamily, theme)
      if (Array.isArray(node.content)) for (const run of node.content) add(run?.fontFamily, theme)
    }
    if (Array.isArray(node.children)) for (const child of node.children) pending.push({ node: child, theme })
    if (record(node.descendants)) {
      for (const patch of Object.values(node.descendants)) pending.push({ node: patch, theme, override: true })
    }
  }

  const picked = new Map()
  for (const family of families) {
    if (!supported || supported.has(family)) picked.set(family, { family, aliases: [] })
  }
  for (const [alias, family] of aliases) picked.get(family)?.aliases.push(alias)
  return [...picked.values()]
}
