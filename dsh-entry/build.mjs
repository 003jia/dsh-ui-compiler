import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, sep } from 'node:path'
import { previewWorkerFiles } from './preview-build.mjs'
import ts from 'typescript'
import { patchCanvasEditorHost } from './agent-editor.mjs'

const upstreamName = '@zseven-w/dsh-openpencil'
const upstreamVersion = '0.1.0-rc.15'
const overlayVersion = '0.1.0-rc.15.uic.18'
const artifactName = `zseven-w-dsh-openpencil-${overlayVersion}.tgz`
const hostEntry = 'lib/index.js'
const clientEntry = 'lib/client.js'
const hostHelper = 'lib/ui-compiler-host.mjs'
const previewRoute = 'lib/ui-compiler-preview-host.mjs'
const previewBuild = 'lib/ui-compiler-preview-build.mjs'
const previewSources = 'lib/ui-compiler-preview-worker'
const previewVendor = 'lib/ui-compiler-preview-vendor'
const upstreamHashes = {
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
  function include(name, importer, optional = false) {
    const paths = createRequire(join(importer, 'package.json')).resolve.paths(name) ?? []
    const path = paths.map(base => join(base, name)).find(base => existsSync(join(base, 'package.json')))
    if (!path && optional) return
    if (!path) throw new Error(`Missing preview dependency ${name}`)
    const source = realpathSync(path)
    if (!source.startsWith(moduleRoot)) throw new Error(`Unexpected preview dependency location: ${name}`)
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

function build(upstreamPath) {
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
    cpSync(join(import.meta.dirname, 'host.mjs'), join(stage, hostHelper))
    cpSync(join(import.meta.dirname, 'preview-host.mjs'), join(stage, previewRoute))
    cpSync(join(import.meta.dirname, 'preview-build.mjs'), join(stage, previewBuild))
    for (const file of ['agent-host.mjs', 'agent-editor.mjs', 'agent-selection.mjs', 'export-host.mjs', 'project-binding.mjs']) {
      cpSync(join(import.meta.dirname, file), join(stage, 'lib', file))
    }
    const wire = readFileSync(join(import.meta.dirname, 'agent-wire.js'), 'utf8')
    writeFileSync(join(stage, 'lib/agent-wire.mjs'), wire + '\nexport { canvasAgentContribution };\n')
    const service = ts.transpileModule(readFileSync(join(import.meta.dirname, 'agent-service.ts'), 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    })
    writeFileSync(join(stage, 'lib/agent-service.mjs'), service.outputText)
    const editorHostFile = join(stage, 'lib/editor-host.js')
    writeFileSync(editorHostFile, patchCanvasEditorHost(readFileSync(editorHostFile, 'utf8')))
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
      "import { mountCanvasAgent } from './agent-service.mjs';",
      "",
    ].join('\n')
    const registration = [
      `    ctx.inject(['typert', 'workspaceRegistry', 'llm', 'agentDefaultModel'], scope => mountCanvasAgent(scope, editorHost, ${JSON.stringify(workspaceRoot)}));`,
      "    ctx.inject(['connection', 'webServer', 'workspaceRegistry'], scope => {",
      "        const lifetime = new AbortController();",
      "        scope.effect(() => () => lifetime.abort(), 'ui-compiler: build lifetime');",
      "        const options = {",
      `            workspaceRoot: ${JSON.stringify(workspaceRoot)}, workspaceRegistry: scope.workspaceRegistry,`,
      "            requestRejection: req => scope.connection.requestRejection(req),",
      "        };",
      "        const buildProject = (snapshot, exportSource) => buildSavedCompilerPreview({",
      "            ...snapshot, exportSource, signal: lifetime.signal,",
      "            snapshotRoot: import.meta.dirname + '/ui-compiler-preview-worker',",
      "            dependencyRoot: import.meta.dirname + '/ui-compiler-preview-vendor',",
      "            nodeExecutable: '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node',",
      "        });",
      "        for (const [path, handler] of [",
      "            [COMPILER_CANVAS_ROUTE, attachCompilerCanvasRoute({ ...options, editorHost, controller })],",
      "            [COMPILER_PREVIEW_ROUTE, attachCompilerPreviewRoute({ ...options, buildCompilerPreview: (_root, snapshot) => buildProject(snapshot, false) })],",
      "            [COMPILER_EXPORT_ROUTE, attachCompilerExportRoute({ ...options, buildExport: (binding, snapshot) => buildProject({ ...snapshot, canvasFile: binding.canvasFile }, true) })],",
      "        ]) scope.effect(() => scope.webServer.register({ kind: 'exact', path, handler }), 'ui-compiler: ' + path);",
      "    });",
      '',
    ].join('\n')
    let host = readFileSync(join(stage, hostEntry), 'utf8')
    host = spliceOnce(host, "export { LEGACY_DESIGN_RENDER_TOOL_NAME", hostImport)
    host = spliceOnce(host, '    ctx.logger.info(`dsh-openpencil mounted (', registration)
    writeFileSync(join(stage, hostEntry), host)

    const sidebarAction = readFileSync(join(import.meta.dirname, 'client.js'), 'utf8').trimEnd()
    const composer = readFileSync(join(import.meta.dirname, 'agent-composer.js'), 'utf8')
    const appearanceCss = ['desktop-appearance.css', 'mcp-appearance.css']
      .map(file => readFileSync(join(import.meta.dirname, file), 'utf8')).join('\n')
    let client = readFileSync(join(stage, clientEntry), 'utf8')
    // Give the project canvas a compact title row while preserving the upstream
    // save control, lifecycle states and toolbar for ordinary editor sessions.
    client = replaceOnce(client, 'workbenchActions, allowTakeover = true', 'workbenchTitle, workbenchActions, allowTakeover = true')
    client = replaceOnce(client, 'style: panelStyles.toolbar,', [
      'className: workbenchTitle ? "uic-canvas-toolbar" : undefined,',
      '            style: workbenchTitle ? undefined : panelStyles.toolbar,',
    ].join('\n'))
    const originalTitle = '/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", {\n\t\t\t\t\tstyle: panelStyles.title,'
    client = replaceOnce(client, originalTitle, 'workbenchTitle ?? ' + originalTitle)
    client = replaceOnce(client, 'const inject = [\n\t"slots",', 'const inject = [\n\t"remote",\n\t"remote.session",\n\t"layout",\n\t"sessions",\n\t"workspaces",\n\t"slots",')
    const surface = 'if (request === void 0) return null;\n\treturn /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ManagedOpenPencilEditorModal, {'
    client = replaceOnce(client, surface, surface.replace('ManagedOpenPencilEditorModal,', 'request.surface ?? ManagedOpenPencilEditorModal,'))
    client = spliceOnce(client, '\t\topen(request) {\n\t\t\tif (destroyed || disposing)', '\t\tisOpen(sessionId) { return store.getSnapshot()?.sessionId === sessionId; },\n')
    client = replaceOnce(client, 'if (previous !== void 0 && !canDiscard()) return false;', [
      'if (request.isCurrent && !request.isCurrent()) return false;',
      '                if (previous?.workspaceId && request.workspaceId && previous.workspaceId !== request.workspaceId) {',
      '                    if (lifecycle.phase === "saving" || lifecycle.dirty) return false;',
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
    manifest.peerDependencies['@deepseek-ai/dsh-typert-protocol'] = '0.2.2-alpha.2'
    writeFileSync(join(stage, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')

    const agentFiles = ['lib/agent-service.mjs', 'lib/agent-wire.mjs', 'lib/agent-host.mjs', 'lib/agent-selection.mjs', 'lib/agent-editor.mjs', 'lib/editor-host.js', 'lib/project-binding.mjs', 'lib/export-host.mjs']
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
    for (const file of [hostEntry, clientEntry, hostHelper, previewRoute, previewBuild, ...agentFiles,
      ...previewWorkerFiles.map(file => join(previewSources, file)), previewVendor + '/vite/package.json',
      'LICENSE', 'THIRD_PARTY_NOTICES.md', 'cordis.patch.yml', 'platforms.json']) {
      if (!files.has(file)) throw new Error(`Packaged overlay is missing ${file}`)
    }
    const artifactPath = join(output, artifactName)
    renameSync(join(temporary, artifactName), artifactPath)
    process.stdout.write(`${artifactPath}\n`)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

try {
  if (process.argv.length !== 3) throw new Error('Usage: node dsh-entry/build.mjs <original-rc.15-directory>')
  build(process.argv[2])
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
