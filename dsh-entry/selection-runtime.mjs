import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { cp, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { patchCompilerFontGlue } from './font-bridge.mjs'
import { patchCompilerFontRenderer } from './font-weights.mjs'
import { collectCanvasFontFamilies } from './font-families.mjs'
import { patchCompilerSelectionGlue } from './selection-bridge.mjs'

const digest = text => createHash('sha256').update(text).digest('hex')
const glueName = 'op_host_web.js'
const rendererName = 'snippets/op-host-web-f712ff5933a5d456/src/op_ck_bridge.js'
const facesName = 'uic-font-faces.mjs'
const fontAssets = new Map([
  ['Noto Sans SC', 'NotoSansSC-VF.ttf'],
  ['IBM Plex Mono', 'IBMPlexMono-Regular.ttf'],
  ['Newsreader', 'Newsreader-VF.ttf'],
])
const fontDirectory = fileURLToPath(new URL('./fonts/', import.meta.url))

// The daemon serves /pkg and /assets relative to OPENPENCIL_WEB_BUNDLE_DIR.
// Each published view owns just the adjusted glue. Other files still come
// from the verified platform package, including the WASM it was built for.
export async function stageSelectionBundle(original, configRoot, glue, fonts = []) {
  const source = await realpath(original)
  const cache = join(configRoot, 'canvas-web-bundles')
  await mkdir(cache, { recursive: true, mode: 0o700 })
  const hasVariableFonts = fonts.some(font => font.family === 'Newsreader' || font.family === 'Noto Sans SC')
  const modules = new Map([[glueName, glue]])
  if (hasVariableFonts) {
    const renderer = await readFile(join(source, rendererName), 'utf8')
    modules.set(rendererName, patchCompilerFontRenderer(renderer))
    modules.set(facesName, await readFile(new URL('./font-faces.mjs', import.meta.url), 'utf8'))
  }
  const key = digest([source, ...Array.from(modules.values(), digest)].join('\0'))
  const destination = join(cache, key)

  async function ready() {
    try {
      if (!(await lstat(destination)).isDirectory()) throw new Error('Invalid cached canvas editor directory')
      for (const [name, content] of modules) {
        const file = join(destination, name)
        if (!(await lstat(file)).isFile() || !Buffer.from(content).equals(await readFile(file))) {
          throw new Error('The cached canvas editor bundle is invalid')
        }
      }
      return true
    } catch (err) {
      if (err.code === 'ENOENT') return false
      throw err
    }
  }

  if (await ready()) return destination
  const temporary = await mkdtemp(join(cache, '.prepare-'))
  try {
    const entries = await readdir(source, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name === glueName) continue
      const target = join(temporary, entry.name)
      const resource = join(source, entry.name)
      if (!entry.isDirectory() && !entry.isFile()) throw new Error('Unexpected editor bundle entry')
      // Windows permits directory junctions without Developer Mode. Copy the
      // remaining flat files there because ordinary file symlinks may fail.
      if (hasVariableFonts && entry.name === 'snippets') {
        // The renderer imports neighboring snippets by relative URL. Stage
        // those verified neighbors but write the adjusted renderer separately.
        await cp(resource, target, {
          recursive: true, mode: constants.COPYFILE_FICLONE, filter: path => path !== join(source, rendererName),
        })
      } else if (process.platform === 'win32' && entry.isFile()) {
        await copyFile(resource, target, constants.COPYFILE_FICLONE)
      } else {
        await symlink(resource, target, entry.isDirectory() ? 'junction' : 'file')
      }
    }
    if (fonts.length) {
      const localFonts = join(temporary, 'uic-fonts')
      await mkdir(localFonts, { mode: 0o700 })
      for (const { family } of fonts) {
        const file = fontAssets.get(family)
        await copyFile(join(fontDirectory, file), join(localFonts, file), constants.COPYFILE_FICLONE)
      }
    }
    for (const [file, content] of modules) {
      await writeFile(join(temporary, file), content, { mode: 0o600, flag: 'wx' })
    }
    try {
      await rename(temporary, destination)
    } catch (err) {
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(err.code) || !await ready()) throw err
    }
    return destination
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

export async function compilerSelectionBundle(original, configRoot, sourcePath) {
  const source = await readFile(join(original, glueName), 'utf8')
  const document = JSON.parse((await readFile(sourcePath, 'utf8')).replace(/^\uFEFF/u, ''))
  const fonts = collectCanvasFontFamilies(document, new Set(fontAssets.keys())).map(({ family, aliases }) => ({
    family, aliases, url: '/pkg/uic-fonts/' + fontAssets.get(family),
  }))
  const selectionGlue = patchCompilerSelectionGlue(source)
  const glue = fonts.length ? patchCompilerFontGlue(selectionGlue, fonts) : selectionGlue
  return stageSelectionBundle(original, configRoot, glue, fonts)
}

function replaceOnce(source, old, next) {
  if (source.split(old).length !== 2) throw new Error('Unexpected OpenPencil process launch implementation')
  return source.replace(old, () => next)
}

/** The ordinary editor host receives an explicit project-canvas marker. */
export function patchCompilerSelectionLaunch(source) {
  return replaceOnce(source, 'managedEditorProcessOptions(runtime, capability.sourcePath, origin)',
    "managedEditorProcessOptions(runtime, capability.sourcePath, origin, ownerSessionId?.startsWith('uic-sidebar-') === true)")
}

export function patchCompilerEditorProcess(source) {
  if (digest(source) !== 'e4c0dba778ce26153e8e9f909268d5077605a1f7690726f2085f35d33f8d4f69') {
    throw new Error('Unexpected OpenPencil managed editor process version')
  }
  source = replaceOnce(source, 'managedEditorProcessOptions(runtime, sourcePath, allowOrigin)',
    'managedEditorProcessOptions(runtime, sourcePath, allowOrigin, compilerCanvas = false)')
  source = replaceOnce(source, '    return {', `    const webBundleDir = compilerCanvas
        ? await (await import('./selection-runtime.mjs')).compilerSelectionBundle(runtime.webBundleDir, configRoot, sourcePath)
        : runtime.webBundleDir;
    return {`)
  return replaceOnce(source, 'OPENPENCIL_WEB_BUNDLE_DIR: runtime.webBundleDir', 'OPENPENCIL_WEB_BUNDLE_DIR: webBundleDir')
}
