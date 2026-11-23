// Register licensed project fonts through the editor's own read-only font load.
// The documented runtime patch for selections runs before this patch; both
// wasm-bindgen entry points below belong to that pinned web-bundle release.
import { createHash } from 'node:crypto'

const knownGlue = new Set([
  'da912b7164b26002b1127a30a06b3029fbfd9aa671efdc932208f25797635a95',
  'b9397450f3318f4b809fd479cc156f87f6157ea33c801d93950cd6d6d909cc00',
])
const fontUrls = new Map([
  ['Noto Sans SC', '/pkg/uic-fonts/NotoSansSC-VF.ttf'],
  ['IBM Plex Mono', '/pkg/uic-fonts/IBMPlexMono-Regular.ttf'],
  ['Newsreader', '/pkg/uic-fonts/Newsreader-VF.ttf'],
])

// Embedded verbatim in the local editor module; no Node APIs or external URLs.
export function createProjectFontReader(frame, fonts, faces) {
  const tracked = new WeakSet()
  const loaded = new Map()
  let preparing
  const familyKey = name => typeof name === 'string' ? name.trim().toLowerCase() : ''

  async function load(font) {
    try {
      const response = await frame.fetch(font.url, {
        credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(12000),
      })
      if (!response.ok || Number(response.headers.get('content-length')) > 32 * 1024 * 1024) return
      const bytes = new Uint8Array(await response.arrayBuffer())
      // All three pinned files are TrueType. A 200 HTML/error body must never
      // be advertised to the native font loader as a usable family.
      if (bytes.length >= 12 && bytes.length <= 32 * 1024 * 1024 &&
          bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0) {
        loaded.set(font.family, bytes)
        if (font.weight) await faces?.registerProjectTypeface(font.family, font.aliases, bytes, font.weight)
      }
    } catch { /* Missing assets leave the native missing-font flow available. */ }
  }

  return {
    prepare() {
      if (!frame || frame.parent === frame || new URL(frame.location.href).searchParams.get('embed') !== 'vscode') return
      preparing ??= Promise.all(fonts.map(load))
      return preparing
    },
    track(store, request) {
      if (store.name === 'imported_fonts' && store.transaction?.db?.name === 'openpencil' &&
          store.transaction.mode === 'readonly') tracked.add(request)
    },
    merge(request, records) {
      if (!tracked.has(request) || !Array.isArray(records)) return records
      const stored = new Map(records.map(row => [familyKey(row?.family), row?.bytes]))
      // A manually imported face keeps the native drawing path, including
      // document aliases that resolve to the same physical family.
      for (const row of records) {
        if (row?.bytes instanceof Uint8Array && row.bytes.length) faces?.excludeProjectTypeface(row.family)
      }
      const rows = [...records]
      let addedBytes = 0
      for (const font of fonts) {
        const family = familyKey(font.family)
        // Aliases use the user's face when this family was supplied manually.
        // One source byte array is shared by all project aliases on the JS side.
        const bytes = stored.get(family) ?? loaded.get(font.family)
        if (!(bytes instanceof Uint8Array) || !bytes.length) continue
        for (const name of [font.family, ...font.aliases]) {
          const key = familyKey(name)
          // Rust copies each face into WASM even when two aliases share JS bytes.
          if (stored.has(key) || addedBytes + bytes.length > 96 * 1024 * 1024) continue
          addedBytes += bytes.length
          rows.push({ family: name, bytes })
          stored.set(key, bytes)
        }
      }
      return rows
    },
  }
}

export function patchCompilerFontGlue(source, fonts) {
  if (!Array.isArray(fonts) || fonts.length > fontUrls.size) throw new Error('Invalid project font manifest')
  const used = new Set()
  const entries = fonts.map(({ family, url, aliases = [] }) => {
    if (!fontUrls.has(family) || url !== fontUrls.get(family) || used.has(family) || !Array.isArray(aliases)) {
      throw new Error('Unexpected project font')
    }
    used.add(family)
    const ids = [...new Set(aliases)].filter(id => typeof id === 'string' && id.length <= 512 &&
      id.startsWith('$') && !/[,\x00-\x1f\x7f]/u.test(id)).slice(0, 256)
    const weight = family === 'Noto Sans SC' ? '100 900' : family === 'Newsreader' ? '200 800' : undefined
    return { family, url, aliases: ids, weight }
  })
  if (!entries.length) return source
  if (!knownGlue.has(createHash('sha256').update(source).digest('hex'))) {
    throw new Error('Unexpected managed OpenPencil font glue version')
  }
  const replace = (original, changed) => {
    if (source.split(original).length !== 2) throw new Error('Unexpected OpenPencil font loader')
    source = source.replace(original, () => changed)
  }
  const mount = 'export function mount_ck(canvas_id) {'
  replace(mount, 'export async function mount_ck(canvas_id) {\n    await uicProjectFontReader.prepare();')
  replace('const ret = getObject(arg0).getAll();', [
    'const store = getObject(arg0);',
    '            const ret = store.getAll();',
    '            uicProjectFontReader.track(store, ret);',
  ].join('\n'))
  // The generated glue has two result getters (IDBRequest and FileReader).
  // Only an IDB request from the marked store can affect the result of either.
  for (const name of ['__wbg_result_452c1006fc727317', '__wbg_result_69b9c700f4d4f22f']) {
    const start = name + ': function() { return handleError(function (arg0) {\n            '
    replace(start + 'const ret = getObject(arg0).result;', start +
      'const request = getObject(arg0);\n            const ret = uicProjectFontReader.merge(request, request.result);')
  }
  const manifest = JSON.stringify(entries).replace(/[<\u2028\u2029]/gu, ch =>
    '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'))
  const variableFonts = entries.some(font => font.weight)
  const resources = variableFonts ? "import * as uicFontFaces from '/pkg/uic-font-faces.mjs';\n" : ''
  return resources + 'const uicProjectFontReader = (' + createProjectFontReader.toString() +
    ")(typeof window === 'undefined' ? null : window, " + manifest +
    (variableFonts ? ', uicFontFaces' : '') + ');\n' + source
}
