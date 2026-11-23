// One ES module instance per editor iframe. Internal CSS names avoid matching a
// user's installed font of the same name while the bundled bytes are loading.
const families = new Map([
  ['noto sans sc', { css: 'DSHProjectNotoSansSC', weight: '100 900' }],
  ['newsreader', { css: 'DSHProjectNewsreader', weight: '200 800' }],
])
const loads = new Map()
const aliases = new Map()
const excluded = new Set()
const nativeRegistrations = new Set()

function familyKey(value) {
  if (typeof value !== 'string') return ''
  const name = value.split(',', 1)[0].trim()
  const quote = name[0]
  return (name.length > 1 && (quote === '"' || quote === "'") && name.endsWith(quote)
    ? name.slice(1, -1).trim() : name).toLowerCase()
}

async function loadFace(face, bytes) {
  try {
    const loaded = await new FontFace(face.css, bytes, { style: 'normal', weight: face.weight }).load()
    document.fonts.add(loaded)
    return true
  } catch {
    // Preserve native rendering after a missing FontFace API or a rejected file.
    return false
  }
}

export async function registerProjectTypeface(family, variableAliases, bytes, weightRange) {
  const key = familyKey(family)
  const face = families.get(key)
  if (!face || face.weight !== weightRange || !(bytes instanceof Uint8Array) || !bytes.byteLength) return false
  if (!loads.has(key)) loads.set(key, loadFace(face, bytes))
  if (!await loads.get(key)) return false
  aliases.set(key, key)
  for (const alias of variableAliases ?? []) {
    const token = familyKey(alias)
    if (token.startsWith('$')) aliases.set(token, key)
  }
  return true
}

export function projectCssFamily(family) {
  const key = familyKey(family)
  const primary = aliases.get(key)
  if (!primary || excluded.has(key) || excluded.has(primary)) return undefined
  return families.get(primary).css
}

// IDB's persisted records have priority over the project defaults. An explicit
// override of the real family also suppresses its document-variable aliases.
export function excludeProjectTypeface(family, exclude = true) {
  const key = familyKey(family)
  if (!key) return
  if (exclude) excluded.add(key)
  else excluded.delete(key)
}

// The native loader registers each merged project row once for each alias. A
// later registration of the same key is a user import; its bytes then own it.
export function noteFontRegistration(family, action = 'register') {
  const key = familyKey(family)
  if (!aliases.has(key)) return
  if (action === 'remove' || nativeRegistrations.has(key)) excluded.add(key)
  nativeRegistrations.add(key)
}
