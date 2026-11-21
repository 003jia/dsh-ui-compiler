import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const modulePath = fileURLToPath(import.meta.url)
const workerFlag = '--build-saved-preview'
const designFile = 'design/pages/mcp-center.op'
const generatedDirectory = 'harness/src/pages/mcp-center'

// Copy these immutable inputs into the plugin package before serving new saves.
export const previewWorkerFiles = Object.freeze([
  'package.json',
  'ui-compiler.map.json',
  'src/compile.ts',
  'src/adapters/op/index.ts',
  'src/emit/dsh-react/index.ts',
  'src/ir/index.ts',
  'tokens/dsw.tokens.json',
  'tokens/primitives.inventory.json',
  'harness/index.html',
  'harness/vite.config.ts',
  'harness/src/fixtures.ts',
  'harness/src/CanvasFramePreview.tsx',
  'harness/src/BoardPreview.tsx',
  'harness/src/project-main.tsx',
  'harness/src/main.tsx',
  'harness/src/preview.css',
])

const generatedFiles = [
  'McpCenterView.generated.tsx',
  'McpCenterView.generated.module.css',
  'mcp-center.locales.generated.ts',
]

function sha256(contents, encoding = 'hex') {
  return createHash('sha256').update(contents).digest(encoding)
}

function currentInputHash(workspaceRoot, compiled = true) {
  const design = join(workspaceRoot, designFile)
  const generated = join(workspaceRoot, generatedDirectory)
  const inputHash = sha256(readFileSync(design))
  if (!compiled) return inputHash
  const manifest = JSON.parse(readFileSync(join(generated, '.uic-manifest.json'), 'utf8'))
  if (manifest?.version !== 1 || inputHash !== manifest.inputHash) {
    throw new Error('The MCP Center preview needs a fresh compilation of design/pages/mcp-center.op.')
  }
  for (const filename of generatedFiles) {
    const actual = sha256(readFileSync(join(generated, filename)))
    if (manifest.outputs?.[filename] !== actual) {
      throw new Error(`The MCP Center preview has stale or edited generated output: ${filename}`)
    }
  }
  return inputHash
}

function savedPreviewFrames(workspaceRoot, inputHash, hasCompiledPage) {
  const source = readFileSync(join(workspaceRoot, designFile))
  if (sha256(source) !== inputHash) throw new Error('The saved design changed during preview generation.')
  const doc = JSON.parse(source.toString('utf8'))
  const compiled = new Set(hasCompiledPage
    ? JSON.parse(readFileSync(join(workspaceRoot, generatedDirectory, '.uic-manifest.json'), 'utf8')).frameIds
    : [])
  const pages = doc.pages?.length ? doc.pages : [doc]
  return pages.flatMap(page => page.children ?? []).filter(frame =>
    frame.type === 'frame' && !compiled.has(frame.id) && !frame.name?.startsWith('_') &&
    !frame.reusable && frame.visible !== false && frame.enabled !== false && !frame.hidden)
}

/** Bundle the current compiler output for an iframe with sandbox="allow-scripts". */
export async function buildCompilerPreview(workspaceRoot, hasCompiledPage = true) {
  const inputHash = currentInputHash(workspaceRoot, hasCompiledPage)
  const require = createRequire(join(workspaceRoot, 'package.json'))
  const { build } = await import(pathToFileURL(require.resolve('vite')).href)
  const result = await build({
    configFile: join(workspaceRoot, 'harness/vite.config.ts'),
    mode: 'production',
    plugins: hasCompiledPage ? [] : [{
      name: 'uic:project-preview',
      transformIndexHtml: { order: 'pre', handler: html => html.replace('/src/main.tsx', '/src/project-main.tsx') },
    }],
    logLevel: 'silent',
    build: {
      write: false,
      copyPublicDir: false,
      sourcemap: false,
      cssCodeSplit: false,
      assetsInlineLimit: Number.MAX_SAFE_INTEGER,
      modulePreload: false,
      rollupOptions: { output: { format: 'iife', inlineDynamicImports: true } },
    },
  })
  if (currentInputHash(workspaceRoot, hasCompiledPage) !== inputHash) {
    throw new Error('The MCP Center design changed while its preview was being built.')
  }

  const output = result.output ?? []
  const script = output.find(entry => entry.type === 'chunk' && entry.isEntry)
  const stylesheet = output.find(entry => entry.type === 'asset' && entry.fileName.endsWith('.css'))
  const index = output.find(entry => entry.type === 'asset' && entry.fileName === 'index.html')
  if (output.length !== 3 || !script || !stylesheet || !index ||
      script.imports.length || script.dynamicImports.length || script.referencedFiles.length) {
    throw new Error('The MCP Center preview must bundle one script and one stylesheet without external assets.')
  }

  const code = script.code
  const css = String(stylesheet.source)
  const frames = savedPreviewFrames(workspaceRoot, inputHash, hasCompiledPage)
  // Reject a bundle that would escape its enclosing HTML elements.
  if (/<\/script(?=[\s/>])/iu.test(code) || /<\/style(?=[\s/>])/iu.test(css)) {
    throw new Error('The MCP Center preview contains an unsafe inline script or stylesheet delimiter.')
  }
  const policy = [
    "default-src 'none'",
    `script-src 'sha256-${sha256(code, 'base64')}'`,
    "style-src 'unsafe-inline'",
    'img-src data:',
    'font-src data:',
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ')
  const html = [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    `<meta name="uic-input-sha256" content="${inputHash}">`,
    `<meta http-equiv="Content-Security-Policy" content="${policy}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>页面预览</title>',
    `<style>${css}</style>`,
    '</head>',
    '<body>',
    '<div id="root"></div>',
    `<script type="application/json" id="uic-saved-frames">${JSON.stringify(frames).replaceAll('<', '\\u003c')}</script>`,
    `<script>${code}</script>`,
    '</body>',
    '</html>',
  ].join('\n')
  return { html, inputHash }
}

/** Compile a verified saved design in a subprocess using only packaged code and dependencies. */
export async function buildSavedCompilerPreview({
  snapshotRoot,
  dependencyRoot,
  nodeExecutable = process.execPath,
  source,
  inputHash,
  signal,
  canvasFile = designFile,
  exportSource = false,
}) {
  if (!isAbsolute(snapshotRoot) || !isAbsolute(dependencyRoot) || !isAbsolute(nodeExecutable)) {
    throw new Error('The MCP Center preview worker requires absolute package and Node paths.')
  }
  if (!Buffer.isBuffer(source) || sha256(source) !== inputHash) {
    throw new Error('The saved MCP Center design does not match its preview hash.')
  }
  signal?.throwIfAborted()
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-uic-preview-'))
  try {
    for (const path of previewWorkerFiles) {
      const destination = join(scratch, path)
      await mkdir(dirname(destination), { recursive: true })
      await cp(join(snapshotRoot, path), destination)
    }
    await cp(dependencyRoot, join(scratch, 'node_modules'), { recursive: true })
    const design = join(scratch, designFile)
    await mkdir(dirname(design), { recursive: true })
    await writeFile(design, source)

    const { stdout } = await execute(nodeExecutable, [modulePath, workerFlag, scratch,
      canvasFile === designFile ? 'calibration' : 'project', exportSource ? 'source' : 'preview'], {
      cwd: scratch,
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        NODE_ENV: 'production',
        ...(process.platform === 'win32'
          ? { SystemRoot: process.env.SystemRoot, TEMP: scratch, TMP: scratch }
          : { TMPDIR: scratch }),
      },
      signal,
      timeout: 20_000,
      maxBuffer: 4 * 1024 * 1024,
    })
    const result = JSON.parse(stdout)
    if (exportSource && result?.inputHash === inputHash && typeof result.files?.['UiPage.tsx'] === 'string') return result
    if (result?.inputHash !== inputHash || typeof result.html !== 'string' || result.html.length === 0) {
      throw new Error('The MCP Center preview worker returned an invalid result.')
    }
    return { html: result.html, inputHash }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

function frontendSource(root, compiled) {
  const inputHash = currentInputHash(root, compiled)
  const frames = savedPreviewFrames(root, inputHash, compiled)
  if (!compiled && frames.length === 0) throw new Error('Save a visible frame before exporting.')
  const compiledBoardId = compiled ? JSON.parse(readFileSync(join(root, generatedDirectory, '.uic-manifest.json'), 'utf8')).frameIds[0] : undefined
  const files = {
    'boards.json': JSON.stringify(frames, null, 2) + '\n',
    'CanvasFramePreview.tsx': readFileSync(join(root, 'harness/src/CanvasFramePreview.tsx'), 'utf8'),
    'UiPage.tsx': [
      "import { CanvasFramePreview, type CanvasAction } from './CanvasFramePreview'",
      "import savedBoards from './boards.json'",
      ...(compiled ? ["import { McpCenterView, type McpCenterViewProps } from './McpCenterView.generated'"] : []),
      '',
      ...(compiled ? ["export const compiledBoardId = " + JSON.stringify(compiledBoardId)] : []),
      'export const boards: ReadonlyArray<{ id: string; name?: string }> = savedBoards',
      '',
      'export interface UiPageProps {',
      '  boardId?: string',
      '  onAction?: CanvasAction',
      ...(compiled ? ['  mcpProps?: McpCenterViewProps'] : []),
      '}',
      '',
      '// Pass onAction to connect a design button to your service using its stable layer ID.',
      'export default function UiPage(props: UiPageProps) {',
      '  const board = props.boardId === undefined ? boards[boards.length - 1] : boards.find(item => item.id === props.boardId)',
      '  if (board) return <CanvasFramePreview frame={board} onAction={props.onAction} />',
      ...(compiled ? ['  if (props.boardId === undefined || props.boardId === compiledBoardId) return <McpCenterView {...props.mcpProps} />'] : []),
      '  return null',
      '}',
      '',
    ].join('\n'),
  }
  if (compiled) {
    for (const name of generatedFiles) files[name] = readFileSync(join(root, generatedDirectory, name), 'utf8')
  }
  return { inputHash, files }
}

if (process.argv[1] && resolve(process.argv[1]) === modulePath && process.argv[2] === workerFlag) {
  const scratch = process.argv[3]
  try {
    const doc = JSON.parse(readFileSync(join(scratch, designFile), 'utf8'))
    const pages = doc.pages?.length ? doc.pages : [doc]
    const compiled = process.argv[4] === 'calibration' && pages.some(page => page.children?.some(frame =>
      frame.type === 'frame' && ['MCP 中心', 'MCP 中心/default'].includes(frame.name) &&
      frame.visible !== false && frame.enabled !== false && !frame.hidden))
    if (compiled) {
      const { compileDesign } = await import(pathToFileURL(join(scratch, 'src/compile.ts')).href)
      compileDesign({
        projectRoot: scratch,
        design: join(scratch, designFile),
        frame: 'MCP 中心',
        name: 'McpCenterView',
        out: join(scratch, generatedDirectory),
        strict: false,
        nativePreviewLayout: true,
      })
    }
    const result = process.argv[5] === 'source' ? frontendSource(scratch, compiled) : await buildCompilerPreview(scratch, compiled)
    process.stdout.write(JSON.stringify(result))
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}
