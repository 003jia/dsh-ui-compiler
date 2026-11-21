import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer, type Server } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { basename, extname, join, relative, resolve } from 'node:path'
import pixelmatch from 'pixelmatch'
import { PNG } from 'pngjs'
import { chromium, type Browser } from 'playwright-core'
import { createServer, type ViteDevServer } from 'vite'
import { readOpDocument } from '../adapters/op/index.ts'
import type { DesignState } from '../ir/index.ts'

type Theme = 'light' | 'dark'
type VerifyOptions = { projectRoot: string; design: string; frame: string; theme?: string }
type Json = Record<string, unknown>
type ComparisonBase = { theme: Theme; state: DesignState; frameId: string; frameName: string; directory: string }
type Comparison = ComparisonBase & (
  | {
    status: 'compared'
    width: number
    height: number
    differingPixels: number
    totalPixels: number
    diffRatio: number
    designTheme: { axis: string; value: string } | null
    designSha256: string
    actualSha256: string
    diffSha256: string
    harnessInputSha256: string | null
  }
  | { status: 'error'; error: string }
)

const rendererVersion = '0.1.0-rc.15'
const pixelThreshold = 0.1

function record(value: unknown): Json | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function hash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function renderer(projectRoot: string) {
  const packageName = `@zseven-w/dsh-openpencil-${process.platform}-${process.arch}`
  const projectPackage = join(projectRoot, 'node_modules', packageName)
  const desktopPackage = join(homedir(), '.dsh/profiles/desktop/node_modules', packageName)
  const directory = process.env.UIC_OPENPENCIL_RUNTIME_ROOT
    ?? (existsSync(projectPackage) ? projectPackage : desktopPackage)
  const binaryName = process.platform === 'win32' ? 'op-host-web-server.exe' : 'op-host-web-server'
  const binary = join(directory, 'bin', binaryName)
  if (!existsSync(binary)) {
    throw new Error(`Install ${packageName}@${rendererVersion} or set UIC_OPENPENCIL_RUNTIME_ROOT to the package directory`)
  }
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  const runtime = JSON.parse(readFileSync(join(directory, 'openpencil-runtime.json'), 'utf8'))
  if (manifest.name !== packageName || manifest.version !== rendererVersion || runtime.packageName !== packageName) {
    throw new Error(`Expected OpenPencil renderer ${packageName}@${rendererVersion}`)
  }
  const sha256 = hash(readFileSync(binary))
  if (runtime.files?.[`bin/${binaryName}`] !== sha256) {
    throw new Error('OpenPencil renderer binary differs from its shipped manifest')
  }
  return { binary, packageName, version: rendererVersion, revision: runtime.openPencilRevision, sha256 }
}

function chromeExecutable(): string | undefined {
  if (process.env.UIC_CHROME_EXECUTABLE) return process.env.UIC_CHROME_EXECUTABLE
  const bundle = 'Google Chrome.app/Contents/MacOS/Google Chrome'
  const local = [join('/Applications', bundle), join(homedir(), 'Applications', bundle)].find(existsSync)
  if (local) return local
  if (existsSync(chromium.executablePath())) return undefined
  throw new Error('Chrome was not found. Set UIC_CHROME_EXECUTABLE to a Chrome or Chromium binary.')
}

function selectDesignTheme(document: Json, theme: Theme): { axis: string; value: string } | null {
  const candidates = Object.entries(record(document.themes) ?? {}).flatMap(([axis, values]) => {
    if (!Array.isArray(values)) return []
    const value = values.find(item => typeof item === 'string' && item.toLowerCase() === theme)
    return typeof value === 'string' ? [{ axis, value }] : []
  })
  if (!candidates.length && theme === 'light' && !Object.keys(record(document.themes) ?? {}).length) return null
  if (candidates.length === 1) return candidates[0]!
  throw new Error(`Expected one .op theme axis defining '${theme}'; found ${candidates.length}`)
}

function activePageCopy(document: Json, bytes: Buffer, frameId: string): Buffer {
  if (!Array.isArray(document.pages) || document.pages.length === 0) return bytes
  const index = document.pages.findIndex(page => {
    const children = record(page)?.children
    return Array.isArray(children) && children.some(child => record(child)?.id === frameId)
  })
  if (index < 0) throw new Error(`Frame '${frameId}' is absent from .op pages`)
  const editorMeta = record(document.editorMeta) ?? {}
  const current = editorMeta.activePageIndex ?? editorMeta.active_page_index ?? 0
  if (index === current) return bytes
  return Buffer.from(JSON.stringify({ ...document, editorMeta: { ...editorMeta, activePageIndex: index } }))
}

function renderDesign(binary: string, input: string, frameId: string, mode: { axis: string; value: string } | null): Buffer {
  const calls = [
    ...(mode ? [['set_active_axis_value', mode], ['get_active_theme', {}]] as const : []),
    ['export_nodes', { nodeIds: JSON.stringify([frameId]), format: 'png', scale: '1' }] as const,
  ]
  const request = calls.map(([name, args], index) => JSON.stringify({
    jsonrpc: '2.0', id: index + 1, method: 'tools/call', params: { name, arguments: args },
  })).join('\n')
  const response = spawnSync(binary, ['--mcp', input], {
    input: `${request}\n`,
    encoding: 'utf8',
    maxBuffer: 48 * 1024 * 1024,
    timeout: 60_000,
    killSignal: 'SIGKILL',
  })
  if (response.error) throw response.error
  if (response.status !== 0) throw new Error(`OpenPencil renderer exited ${response.status}: ${response.stderr.trim().slice(0, 4000)}`)
  const replies = new Map<number, Json>()
  for (const line of response.stdout.split(/\r?\n/u).filter(line => line.trim())) {
    const reply = record(JSON.parse(line))
    if (reply && typeof reply.id === 'number') replies.set(reply.id, reply)
  }
  const content = calls.map(([name], index) => {
    const reply = replies.get(index + 1)
    const result = record(reply?.result)
    const output = Array.isArray(result?.content)
      ? result.content.map(record).find(item => item?.type === 'text')?.text
      : undefined
    if (typeof output !== 'string' || result?.isError === true || reply?.error) {
      const detail = record(reply?.error)?.message ?? output
      throw new Error(`OpenPencil ${name} failed${detail ? `: ${String(detail)}` : ''}`)
    }
    return record(JSON.parse(output))
  })
  if (mode && record(content[1]?.active)?.[mode.axis] !== mode.value) {
    throw new Error(`OpenPencil did not activate ${mode.axis}=${mode.value}`)
  }
  const exported = content.at(-1)?.files
  const image = Array.isArray(exported) ? exported.map(record).find(item => item?.nodeId === frameId) : undefined
  if (typeof image?.bytes_base64 !== 'string') {
    throw new Error(`OpenPencil did not export frame '${frameId}': ${image?.error ?? 'missing PNG bytes'}`)
  }
  return Buffer.from(image.bytes_base64, 'base64')
}

async function captureActual(
  browser: Browser, address: string, theme: Theme, state: DesignState,
  width: number, height: number, inputHash: string,
) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    colorScheme: theme,
    reducedMotion: 'reduce',
    locale: 'zh-CN',
  })
  try {
    const url = new URL(address)
    url.search = new URLSearchParams({ theme, state, locale: 'zh' }).toString()
    await context.route('**/*', route => {
      const requestUrl = new URL(route.request().url())
      if (requestUrl.origin === url.origin || requestUrl.protocol === 'data:') return route.continue()
      return route.abort()
    })
    const page = await context.newPage()
    const pageErrors: string[] = []
    page.on('pageerror', error => pageErrors.push(error.message))
    try {
      const response = await page.goto(url.href, { waitUntil: 'load', timeout: 15_000 })
      if (!response?.ok()) throw new Error(`Harness returned ${response?.status() ?? 'no response'}`)
      const ready = page.locator(`[data-uic-ready][data-uic-theme="${theme}"][data-uic-state="${state}"]`)
      await ready.waitFor({ state: 'visible', timeout: 8_000 })
      const harnessInputSha256 = await ready.getAttribute('data-uic-input-sha256')
      if (harnessInputSha256 !== null && harnessInputSha256 !== inputHash) {
        throw new Error('Harness view input hash differs from the design. Compile the current design before verifying.')
      }
      await page.waitForFunction(() => document.fonts.status === 'loaded', undefined, { timeout: 10_000 })
      const actual = await page.screenshot({ animations: 'disabled', caret: 'hide', scale: 'css', timeout: 10_000 })
      if (pageErrors.length) throw new Error(pageErrors.join('; '))
      return { actual, harnessInputSha256 }
    } catch (error) {
      throw new Error(`Harness capture failed: ${pageErrors.length ? pageErrors.join('; ') : errorMessage(error)}`, { cause: error })
    }
  } finally {
    await context.close()
  }
}

export async function verifyDesign({ projectRoot, design, frame, theme = 'light,dark' }: VerifyOptions) {
  const source = resolve(design)
  if (extname(source).toLowerCase() !== '.op') throw new Error('Verify requires a .op design')
  const themes = theme.split(',').map(value => value.trim())
  if (themes.some(value => value !== 'light' && value !== 'dark') || new Set(themes).size !== themes.length) {
    throw new Error('Theme must be light, dark, or light,dark')
  }
  const sourceBytes = readFileSync(source)
  const inputHash = hash(sourceBytes)
  const document = record(JSON.parse(sourceBytes.toString('utf8')))
  if (!document) throw new Error('.op document must be an object')
  const temporary = mkdtempSync(join(tmpdir(), 'uic-verify-'))
  const name = basename(source, extname(source)).replace(/[^\p{L}\p{N}-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'design'
  const parentDirectory = join(projectRoot, 'artifacts', 'verify', name)
  const errors: string[] = []
  const results: Comparison[] = []
  let openpencil: ReturnType<typeof renderer> | undefined
  let browser: Browser | undefined
  let browserVersion: string | undefined
  let vite: ViteDevServer | undefined
  let httpServer: Server | undefined
  let outputDirectory: string
  try {
    mkdirSync(parentDirectory, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
    outputDirectory = mkdtempSync(join(parentDirectory, `${stamp}-`))
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true })
    throw error
  }

  try {
    const input = join(temporary, 'source.op')
    writeFileSync(input, sourceBytes)
    const page = readOpDocument(input, frame)
    openpencil = renderer(projectRoot)
    const executablePath = chromeExecutable()
    vite = await createServer({
      root: join(projectRoot, 'harness'),
      logLevel: 'error',
      server: { middlewareMode: true, hmr: false },
    })
    const server = httpServer = createHttpServer(vite.middlewares)
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolveListen)
    })
    const address = server.address()
    if (!address || typeof address === 'string' || address.address !== '127.0.0.1') {
      throw new Error('Vite harness did not bind to an IPv4 loopback address')
    }
    browser = await chromium.launch({ executablePath, headless: true, timeout: 15_000 })
    browserVersion = browser.version()
    for (const selection of page.frames) {
      for (const selectedTheme of themes as Theme[]) {
        const directory = join(outputDirectory, ...(page.frames.length === 1 ? [] : [selection.state]), selectedTheme)
        const base: ComparisonBase = {
          theme: selectedTheme, state: selection.state, frameId: selection.node.id, frameName: selection.node.name,
          directory: relative(outputDirectory, directory),
        }
        mkdirSync(directory, { recursive: true })
        let result: Comparison
        try {
          const themedCopy = join(temporary, `${selection.state}-${selectedTheme}.op`)
          writeFileSync(themedCopy, activePageCopy(document, sourceBytes, selection.node.id))
          const mode = selectDesignTheme(document, selectedTheme)
          const designImage = renderDesign(openpencil.binary, themedCopy, selection.node.id, mode)
          writeFileSync(join(directory, 'design.png'), designImage)
          const designPng = PNG.sync.read(designImage)
          const { width, height } = designPng
          const { actual, harnessInputSha256 } = await captureActual(
            browser, `http://127.0.0.1:${address.port}/`, selectedTheme, selection.state, width, height, inputHash,
          )
          writeFileSync(join(directory, 'actual.png'), actual)
          const actualPng = PNG.sync.read(actual)
          if (actualPng.width !== width || actualPng.height !== height) {
            throw new Error(`Screenshot is ${actualPng.width}×${actualPng.height} for a ${width}×${height} design`)
          }
          const diff = new PNG({ width, height })
          const differingPixels = pixelmatch(designPng.data, actualPng.data, diff.data, width, height, {
            threshold: pixelThreshold, includeAA: false,
          })
          const diffImage = PNG.sync.write(diff)
          writeFileSync(join(directory, 'diff.png'), diffImage)
          result = {
            ...base, status: 'compared', width, height, differingPixels, totalPixels: width * height,
            diffRatio: differingPixels / (width * height), designTheme: mode,
            designSha256: hash(designImage), actualSha256: hash(actual), diffSha256: hash(diffImage), harnessInputSha256,
          }
        } catch (error) {
          result = { ...base, status: 'error', error: errorMessage(error) }
          errors.push(`${selection.node.name} (${selectedTheme}): ${result.error}`)
        }
        results.push(result)
        writeJson(join(directory, 'report.json'), result)
      }
    }
  } catch (error) {
    errors.push(errorMessage(error))
  } finally {
    const server = httpServer
    const closeHttp = server?.listening && new Promise<void>((resolveClose, reject) => {
      server.close(error => error ? reject(error) : resolveClose())
      server.closeAllConnections()
    })
    const cleanup = await Promise.allSettled([browser?.close(), vite?.close(), closeHttp])
    for (const result of cleanup) {
      if (result.status === 'rejected') errors.push(`Verify cleanup failed: ${errorMessage(result.reason)}`)
    }
    rmSync(temporary, { recursive: true, force: true })
  }
  const reportPath = join(outputDirectory, 'report.json')
  const report = {
    source: relative(projectRoot, source), inputHash, requestedFrame: frame, requestedThemes: themes,
    openpencil, browserVersion, viewportScale: 1, locale: 'zh', pixelThreshold, includeAA: false, results, errors,
  }
  writeJson(reportPath, report)
  return { ...report, outputDirectory, reportPath }
}
