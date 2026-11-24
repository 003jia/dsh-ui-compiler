import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, sep } from 'node:path'
import { previewWorkerFiles } from './preview-build.mjs'
import ts from 'typescript'
import { patchCompilerAutosave } from './canvas-autosave.mjs'
import { patchCanvasEditorHost } from './agent-editor.mjs'
import { patchCompilerEditorProcess, patchCompilerSelectionLaunch } from './selection-runtime.mjs'

const upstreamName = '@zseven-w/dsh-openpencil'
const upstreamVersion = '0.1.0-rc.15'
const overlayVersion = '0.1.0-rc.15.uic.40'
const artifactName = `zseven-w-dsh-openpencil-${overlayVersion}.tgz`
const hostEntry = 'lib/index.js'
const clientEntry = 'lib/client.js'
const hostHelper = 'lib/ui-compiler-host.mjs'
const previewRoute = 'lib/ui-compiler-preview-host.mjs'
const previewBuild = 'lib/ui-compiler-preview-build.mjs'
const previewSources = 'lib/ui-compiler-preview-worker'
const previewVendor = 'lib/ui-compiler-preview-vendor'
const upstreamHashes = {
  'lib/editor-runtime.js': '859b1012e1dd8396dfff93fc285275228a889f8c332c858aa8f86c175f078ca3',
  [hostEntry]: '1471dac77ec3cee88509b453e8f1048c072f7941ac8807712fba58652c524a8e',
  [clientEntry]: '2c4be0f7d0c8f44f53d3cdb447410d2b11a11a9d076f8c6154fcd1f46d900453',
}

function spliceOnce(code, anchor, insertion) {
  const [before, after, ...duplicates] = code.split(anchor)
  if (after === undefined || duplicates.length > 0) {
    throw new Error(`Expected one upstream anchor: ${anchor.trim()}`)
  }
  return before + insertion + anchor + after
}

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${result.stderr?.trim() || result.stdout?.trim() || result.signal}`)
  }
  return result.stdout
}

// Stage the installed dependency closure. The desktop worker only executes
// code from its installed plugin and reads the saved design as data.
function stagePreviewDependencies(workspaceRoot, destination) {
  const visited = new Map()
  const moduleRoot = realpathSync(join(workspaceRoot, 'node_modules')) + sep
  function resolvePackage(name, importer, optional = false) {
    const paths = createRequire(join(importer, 'package.json')).resolve.paths(name) ?? []
    const path = paths.map(base => join(base, name)).find(base => existsSync(join(base, 'package.json')))
    if (!path && optional) return
    if (!path) throw new Error(`Missing preview dependency ${name}`)
    const source = realpathSync(path)
    if (!source.startsWith(moduleRoot)) throw new Error(`Unexpected preview dependency location: ${name}`)
    return source
  }
  function include(name, importer, optional = false) {
    let source = resolvePackage(name, importer, optional)
    if (!source) return
    if (name === 'rollup') {
      // Vite imports "rollup"; the hardened desktop Node can load Rollup's
      // official WebAssembly build without loading a third-party native addon.
      const expected = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
      source = resolvePackage('@rollup/wasm-node', workspaceRoot)
      const wasm = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
      if (expected.name !== 'rollup' || wasm.name !== '@rollup/wasm-node' || wasm.version !== expected.version) {
        throw new Error(`Preview needs @rollup/wasm-node@${expected.version} to match Vite's Rollup`)
      }
    }
    if (visited.has(name)) {
      if (visited.get(name) !== source) throw new Error(`Multiple installed versions of ${name}`)
      return
    }
    visited.set(name, source)
    const target = join(destination, name)
    mkdirSync(dirname(target), { recursive: true })
    cpSync(source, target, { recursive: true, filter: item => item !== join(source, 'node_modules') })
    // The harness extracts these two packages' shipped declarations and CSS.
    if (name.startsWith('@deepseek-ai/')) return
    const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
    for (const child of Object.keys(manifest.dependencies ?? {})) include(child, source)
    for (const child of Object.keys(manifest.optionalDependencies ?? {})) include(child, source, true)
  }
  for (const name of ['vite', 'typescript', 'react', 'react-dom', 'clsx',
    '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-theme']) include(name, workspaceRoot)
}

function replaceOnce(code, anchor, replacement) {
  if (code.split(anchor).length !== 2) throw new Error(`Unexpected upstream code: ${anchor.trim()}`)
  return code.replace(anchor, () => replacement)
}

// The native package ships its own SHA-256 file inventory. Pin the inventory
// and its adjacent metadata, then copy only those exact files into the release.
function stageAppleSiliconRuntime(source, stage, manifest) {
  const platform = 'darwin-arm64'
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error('Build the Apple Silicon release on macOS arm64 to include the matching esbuild.')
  }
  const destination = 'npm/' + platform
  const metadata = {
    'openpencil-runtime.json': '5f11bcc98a47f1a893d713c014c3c413d3d9ba3485abcf9375347c2aa333ef77',
    'package.json': '6c12748b50a90294ba708ff01f842c48ab9e005e7f74f27ecdfb6da6db341904',
    'LICENSE': '07810262dcd2df061e16ae24c3a9a7a3cd265ddfc2bfb073544cd11af22d7812',
    'THIRD_PARTY_NOTICES.md': '06b6ae7706cd7e2650c44d9403397206556b12c796ff9595ff80d22f0ec82b90',
  }
  function copyVerified(file, expected) {
    const bytes = readFileSync(join(source, file))
    if (createHash('sha256').update(bytes).digest('hex') !== expected) {
      throw new Error('Pinned Apple Silicon runtime checksum mismatch: ' + file)
    }
    const target = join(stage, destination, file)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, bytes, { mode: file === 'bin/op-host-web-server' ? 0o755 : 0o644 })
  }
  for (const [file, digest] of Object.entries(metadata)) copyVerified(file, digest)
  const inventory = JSON.parse(readFileSync(join(stage, destination, 'openpencil-runtime.json'), 'utf8'))
  for (const [file, digest] of Object.entries(inventory.files)) copyVerified(file, digest)

  const catalogPath = join(stage, 'platforms.json')
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'))
  catalog.platforms = catalog.platforms.filter(entry => entry.id === platform)
  writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + '\n')
  // Respect explicit upstream overrides. Otherwise always resolve from this
  // install, even when an older optional package is visible in a parent tree.
  const resolver = join(stage, 'lib/editor-runtime.js')
  const code = readFileSync(resolver, 'utf8')
  writeFileSync(resolver, spliceOnce(code, '    const resolvePackageJson = options.resolvePackageJson', [
    "    if (platform.id === 'darwin-arm64') {",
    "        return validateRuntimeRoot(join(projectRoot, 'npm', platform.id), 'development-package', expected, io);",
    "    }",
    "",
  ].join('\n')))
  manifest.os = ['darwin']
  manifest.cpu = ['arm64']
  delete manifest.optionalDependencies
  manifest.files.push(destination)
  return [...Object.keys(metadata), ...Object.keys(inventory.files)].map(file => destination + '/' + file)
}

function build(upstreamPath, nativePath) {
  const upstream = realpathSync(upstreamPath)
  const workspaceRoot = realpathSync(join(import.meta.dirname, '..'))
  const manifest = JSON.parse(readFileSync(join(upstream, 'package.json'), 'utf8'))
  if (manifest.name !== upstreamName || manifest.version !== upstreamVersion) {
    throw new Error(`Pass the original, unmodified ${upstreamName}@${upstreamVersion} directory.`)
  }
  for (const [file, expected] of Object.entries(upstreamHashes)) {
    const actual = createHash('sha256').update(readFileSync(join(upstream, file))).digest('hex')
    if (actual !== expected) throw new Error(`Upstream content does not match the pinned release: ${file}`)
  }

  const output = join(workspaceRoot, 'artifacts', 'dsh-sidebar-button')
  mkdirSync(output, { recursive: true })
  const temporary = mkdtempSync(join(output, '.build-'))
  try {
    const stage = join(temporary, 'upstream')
    cpSync(upstream, stage, { recursive: true })
    const nativeFiles = nativePath ? stageAppleSiliconRuntime(nativePath, stage, manifest) : []
    cpSync(join(import.meta.dirname, 'host.mjs'), join(stage, hostHelper))
    cpSync(join(import.meta.dirname, 'preview-host.mjs'), join(stage, previewRoute))
    cpSync(join(import.meta.dirname, 'preview-build.mjs'), join(stage, previewBuild))
    for (const file of ['agent-host.mjs', 'parallel-agent.mjs', 'agent-editor.mjs', 'agent-selection.mjs', 'export-host.mjs', 'project-binding.mjs', 'asset-store.mjs', 'draw-tools.mjs', 'canvas-tools.mjs', 'canvas-tool-loop.mjs', 'task-plan.mjs', 'conversations.mjs', 'pen-document.mjs', 'pen-context.mjs', 'pen-import.mjs', 'selection-runtime.mjs', 'selection-bridge.mjs', 'font-bridge.mjs', 'font-families.mjs', 'font-faces.mjs', 'font-weights.mjs']) {
      cpSync(join(import.meta.dirname, file), join(stage, 'lib', file))
    }
    const fontFiles = ['NotoSansSC-VF.ttf', 'Newsreader-VF.ttf', 'IBMPlexMono-Regular.ttf', 'OFL-NotoSansSC.txt',
      'OFL-Newsreader.txt', 'OFL-IBMPlexMono.txt', 'manifest.json']
    mkdirSync(join(stage, 'lib/fonts'))
    for (const file of fontFiles) cpSync(join(import.meta.dirname, 'fonts', file), join(stage, 'lib/fonts', file))
    const wire = readFileSync(join(import.meta.dirname, 'agent-wire.js'), 'utf8')
    writeFileSync(join(stage, 'lib/agent-wire.mjs'), wire + '\nexport { canvasAgentContribution };\n')
    const service = ts.transpileModule(readFileSync(join(import.meta.dirname, 'agent-service.ts'), 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    })
    writeFileSync(join(stage, 'lib/agent-service.mjs'), service.outputText)
    const editorHostFile = join(stage, 'lib/editor-host.js')
    writeFileSync(editorHostFile, patchCompilerSelectionLaunch(patchCanvasEditorHost(readFileSync(editorHostFile, 'utf8'))))
    const processFile = join(stage, 'lib/managed-editor-process.js')
    writeFileSync(processFile, patchCompilerEditorProcess(readFileSync(processFile, 'utf8')))
    const inventory = readFileSync(join(workspaceRoot, 'tokens/primitives.inventory.json'), 'utf8')
    if (/import\(\\"(?:\/|[A-Za-z]:)/u.test(inventory)) {
      throw new Error('Regenerate the portable component inventory with pnpm uic inventory before packaging.')
    }
    for (const file of previewWorkerFiles) {
      const target = join(stage, previewSources, file)
      mkdirSync(dirname(target), { recursive: true })
      cpSync(join(workspaceRoot, file), target)
    }
    stagePreviewDependencies(workspaceRoot, join(stage, previewVendor))

    const hostImport = [
      "import { attachCompilerCanvasRoute, COMPILER_CANVAS_ROUTE } from './ui-compiler-host.mjs';",
      "import { attachCompilerPreviewRoute, COMPILER_PREVIEW_ROUTE } from './ui-compiler-preview-host.mjs';",
      "import { buildSavedCompilerPreview } from './ui-compiler-preview-build.mjs';",
      "import { attachCompilerExportRoute, COMPILER_EXPORT_ROUTE } from './export-host.mjs';",
      "import { attachCompilerConfigRoute, attachCompilerAssetRoute, attachCompilerPenImportRoute, COMPILER_PEN_IMPORT_ROUTE, attachCompilerImageRoute, attachCompilerConversationsRoute, activeCompilerCanvas, COMPILER_CONFIG_ROUTE, COMPILER_ASSET_ROUTE, COMPILER_IMAGE_ROUTE, COMPILER_CONVERSATIONS_ROUTE } from './ui-compiler-host.mjs';",
      "import { createCompilerDrawTools } from './draw-tools.mjs';",
      "import { mountCanvasAgent } from './agent-service.mjs';",
      "",
    ].join('\n')
    const registration = [
      "    ctx.inject(['typert', 'workspaceRegistry', 'llm', 'agentDefaultModel'], scope => mountCanvasAgent(scope, editorHost));",
      "    ctx.inject(['connection', 'webServer', 'workspaceRegistry'], scope => {",
      "        const lifetime = new AbortController();",
      "        scope.effect(() => () => lifetime.abort(), 'ui-compiler: build lifetime');",
      "        const options = {",
      "            workspaceRegistry: scope.workspaceRegistry,",
      "            requestRejection: req => scope.connection.requestRejection(req),",
      "        };",
      "        const buildProject = (snapshot, exportSource) => buildSavedCompilerPreview({",
      "            ...snapshot, exportSource, signal: lifetime.signal,",
      "            snapshotRoot: import.meta.dirname + '/ui-compiler-preview-worker',",
      "            dependencyRoot: import.meta.dirname + '/ui-compiler-preview-vendor',",
      "        });",
      "        for (const [path, handler] of [",
      "            [COMPILER_CANVAS_ROUTE, attachCompilerCanvasRoute({ ...options, editorHost, controller })],",
      "            [COMPILER_PREVIEW_ROUTE, attachCompilerPreviewRoute({ ...options, buildCompilerPreview: (_root, snapshot) => buildProject(snapshot, false) })],",
      "            [COMPILER_EXPORT_ROUTE, attachCompilerExportRoute({ ...options, buildExport: (binding, snapshot) => buildProject({ ...snapshot, canvasFile: binding.canvasFile }, true) })],",
      "            [COMPILER_CONFIG_ROUTE, attachCompilerConfigRoute(options)],",
      "            [COMPILER_ASSET_ROUTE, attachCompilerAssetRoute(options)],",
      "            [COMPILER_PEN_IMPORT_ROUTE, attachCompilerPenImportRoute({ ...options, editorHost })],",
      "            [COMPILER_IMAGE_ROUTE, attachCompilerImageRoute({ ...options, editorHost })],",
      "            [COMPILER_CONVERSATIONS_ROUTE, attachCompilerConversationsRoute(options)],",
      "        ]) scope.effect(() => scope.webServer.register({ kind: 'exact', path, handler }), 'ui-compiler: ' + path);",
      "    });",
      '',
    ].join('\n')
    let host = readFileSync(join(stage, hostEntry), 'utf8')
    host = spliceOnce(host, "export { LEGACY_DESIGN_RENDER_TOOL_NAME", hostImport)
    host = spliceOnce(host, '    ctx.logger.info(`dsh-openpencil mounted (', registration)
    host = spliceOnce(host, '    ctx.logger.info(`dsh-openpencil mounted (', [
      "    ctx.inject(['tools'], toolCtx => {",
      "        for (const tool of createCompilerDrawTools(editorHost, activeCompilerCanvas)) {",
      "            toolCtx.effect(() => toolCtx.tools.register(tool), 'ui-compiler: ' + tool.name);",
      "        }",
      "    });",
      '',
    ].join('\n'))
    writeFileSync(join(stage, hostEntry), host)

    const sidebarAction = readFileSync(join(import.meta.dirname, 'client.js'), 'utf8').trimEnd()
    const composer = readFileSync(join(import.meta.dirname, 'agent-composer.js'), 'utf8')
    const appearanceCss = ['desktop-appearance.css', 'mcp-appearance.css']
      .map(file => readFileSync(join(import.meta.dirname, file), 'utf8')).join('\n')
    let client = readFileSync(join(stage, clientEntry), 'utf8')
    // Give the project canvas a compact title row while preserving the upstream
    // save control, lifecycle states and toolbar for ordinary editor sessions.
    client = replaceOnce(client, 'workbenchActions, allowTakeover = true', 'workbenchTitle, workbenchActions, allowTakeover = true')
    client = patchCompilerAutosave(client, replaceOnce)
    client = replaceOnce(client, 'style: panelStyles.toolbar,', [
      'className: workbenchTitle ? "uic-canvas-toolbar" : undefined,',
      '            style: workbenchTitle ? undefined : panelStyles.toolbar,',
    ].join('\n'))
    client = spliceOnce(client, '\t\t\trequestClose: async () => {', [
      '            updateAgentWork: state => {',
      '                if (!state || state.sessionId !== launchRef.current?.sessionId || !originRef.current) return;',
      '                iframeRef.current?.contentWindow?.postMessage({...state, type: "uic/agent-work"}, originRef.current);',
      '            },',
      '            readVisualSelection: signal => readCompilerVisualSelection(',
      '                iframeRef.current?.contentWindow, originRef.current, launchRef.current?.sessionId, signal),',
      '',
    ].join('\n'))
    client = spliceOnce(client, 'style: panelStyles.status,', [
      'role: workbenchTitle ? "status" : undefined,',
      '                    title: workbenchTitle ? (locale === "zh-CN" ? "编辑后自动保存" : "Edits are saved automatically") : undefined,',
      '                    ',
    ].join('\n'))
    const originalTitle = '/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", {\n\t\t\t\t\tstyle: panelStyles.title,'
    client = replaceOnce(client, originalTitle, 'workbenchTitle ?? ' + originalTitle)
    client = replaceOnce(client, 'const inject = [\n\t"slots",', 'const inject = [\n\t"remote",\n\t"remote.session",\n\t"layout",\n\t"sessions",\n\t"workspaces",\n\t"slots",')
    const surface = 'if (request === void 0) return null;\n\treturn /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ManagedOpenPencilEditorModal, {'
    client = replaceOnce(client, surface, surface.replace('ManagedOpenPencilEditorModal,', 'request.surface ?? ManagedOpenPencilEditorModal,'))
    client = spliceOnce(client, '\t\topen(request) {\n\t\t\tif (destroyed || disposing)', [
      '        isOpen(sessionId) { return store.getSnapshot()?.sessionId === sessionId; },',
      '        async flushCompilerCanvas(workspaceId) {',
      '            const current = store.getSnapshot();',
      '            if (!current?.workspaceId || (workspaceId && workspaceId !== current.workspaceId)) return true;',
      '            return await flushCompilerCanvasChanges(lifecycle, lifecycleController)',
      '                && current === store.getSnapshot() && !lifecycle.dirty && lifecycle.phase !== "saving";',
      '        },',
      '',
    ].join('\n'))
    client = replaceOnce(client, 'if (previous !== void 0 && !canDiscard()) return false;', [
      'if (request.isCurrent && !request.isCurrent()) return false;',
      '                if (previous?.workspaceId && request.workspaceId && previous.workspaceId !== request.workspaceId) {',
      '                    if (!await flushCompilerCanvasChanges(lifecycle, lifecycleController) || lifecycle.dirty || destroyed || disposing) return false;',
      '                    if (request.isCurrent && !request.isCurrent()) return false;',
      '                } else if (previous !== void 0 && !canDiscard()) return false;',
    ].join('\n'))
    client = spliceOnce(client, 'const accepted = store.open(request);',
      'if (request.isCurrent && !request.isCurrent()) { if (previous && lifecycleController) close(); return false; }\n                ')
    client = replaceOnce(client, 'function apply(ctx) {\n',
      `const desktopAppearanceCss = ${JSON.stringify(appearanceCss)};\n${wire}\n${composer}\n${sidebarAction}\nfunction apply(ctx) {\n`)
    client = spliceOnce(client, '\tconst HostSyncedDesignRenderView = (props) => {', [
      '  let agentRemote;',
      '  mountCompilerSidebarAction(ctx, () => editorWorkbenchHost, () => agentRemote);',
      '  ctx.inject(["remote"], async scope => {',
      '    await scope.remote.$mount(canvasAgentContribution());',
      '    scope.inject(["remote.uiCompilerCanvasAgent"], ready => ready.effect(() => {',
      '      agentRemote = ready.remote.uiCompilerCanvasAgent;',
      '      return () => { agentRemote = undefined; };',
      '    }, "UI compiler: canvas agent client"));',
      '  });',
      '',
    ].join('\n'))
    writeFileSync(join(stage, clientEntry), client)

    manifest.version = overlayVersion
    manifest.dsh.client.inject = [...new Set([...manifest.dsh.client.inject, '@deepseek-ai/dsh-client-ui-sidebar', '@deepseek-ai/dsh-client-ui-layout', '@deepseek-ai/dsh-api-remotes', '@deepseek-ai/dsh-api-session-controller', '@deepseek-ai/dsh-api-workspace-controller'])]
    manifest.peerDependencies['@deepseek-ai/dsh-llm'] = '0.2.2-alpha.2 || 0.2.2-rc.5'
    manifest.peerDependencies['@deepseek-ai/dsh-typert-protocol'] = '0.2.2-alpha.2 || 0.2.2-rc.5'
    writeFileSync(join(stage, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')

    const agentFiles = ['lib/agent-service.mjs', 'lib/agent-wire.mjs', 'lib/agent-host.mjs', 'lib/parallel-agent.mjs', 'lib/agent-selection.mjs', 'lib/agent-editor.mjs', 'lib/editor-host.js', 'lib/project-binding.mjs', 'lib/export-host.mjs', 'lib/asset-store.mjs', 'lib/draw-tools.mjs', 'lib/canvas-tools.mjs', 'lib/canvas-tool-loop.mjs', 'lib/task-plan.mjs', 'lib/conversations.mjs', 'lib/pen-document.mjs', 'lib/pen-context.mjs', 'lib/pen-import.mjs', 'lib/managed-editor-process.js', 'lib/selection-runtime.mjs', 'lib/selection-bridge.mjs', 'lib/font-bridge.mjs', 'lib/font-families.mjs', 'lib/font-faces.mjs', 'lib/font-weights.mjs']
    for (const file of [hostEntry, clientEntry, hostHelper, previewRoute, previewBuild, ...agentFiles]) {
      run(process.execPath, ['--check', join(stage, file)], stage)
    }
    const [packed] = JSON.parse(run('npm', ['pack', '--offline', '--ignore-scripts', '--json', '--pack-destination', temporary], stage, {
      ...process.env,
      npm_config_cache: join(temporary, 'npm-cache'),
    }))
    if (packed?.name !== upstreamName || packed.version !== overlayVersion || packed.filename !== artifactName) {
      throw new Error('The packaged name or version does not match the overlay.')
    }
    const files = new Set(packed.files.map(file => file.path))
    for (const file of [hostEntry, clientEntry, hostHelper, previewRoute, previewBuild, ...agentFiles, ...nativeFiles,
      ...previewWorkerFiles.map(file => join(previewSources, file)), previewVendor + '/vite/package.json',
      previewVendor + '/rollup/dist/wasm-node/bindings_wasm_bg.wasm',
      ...fontFiles.map(file => 'lib/fonts/' + file), 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'cordis.patch.yml', 'platforms.json']) {
      if (!files.has(file)) throw new Error(`Packaged overlay is missing ${file}`)
    }
    if (nativePath) {
      for (const path of ['npm/darwin-arm64/bin/op-host-web-server', previewVendor + '/@esbuild/darwin-arm64/bin/esbuild']) {
        const file = packed.files.find(item => item.path === path)
        if (!file || !(file.mode & 0o111)) throw new Error('Missing executable in Apple Silicon release: ' + path)
      }
    }
    const artifactPath = join(output, artifactName)
    renameSync(join(temporary, artifactName), artifactPath)
    process.stdout.write(`${artifactPath}\n`)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

try {
  const [upstream, option, native, ...extra] = process.argv.slice(2)
  if (!upstream || extra.length || (option !== undefined && (option !== '--bundle-darwin-arm64' || !native))) {
    throw new Error('Usage: node dsh-entry/build.mjs <original-rc.15-directory> [--bundle-darwin-arm64 <native-rc.15-directory>]')
  }
  build(upstream, native)
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
