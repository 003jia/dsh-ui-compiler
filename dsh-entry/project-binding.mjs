import { constants } from 'node:fs'
import { link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { readProjectConfig } from './asset-store.mjs'

// Workspace identities are minted by DSH and looked up again on every request.
// A caller never selects a path or supplies a project root.
export function validWorkspaceId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
}

export function workspaceIdFromRequest(req) {
  const id = req.headers?.['x-uic-workspace']
  if (!validWorkspaceId(id)) throw new Error('Expected a DSH workspace ID')
  return id
}

export async function resolveProjectBinding(workspaceRegistry, workspaceId, legacyWorkspaceRoot) {
  if (!validWorkspaceId(workspaceId)) throw new Error('Invalid DSH workspace ID')
  const project = workspaceRegistry.get(workspaceId)
  if (project?.id !== workspaceId || typeof project.path !== 'string' || !isAbsolute(project.path)) {
    throw new Error('Unregistered DSH workspace')
  }
  // The registry stores canonical host paths. Refuse a deleted root which has
  // since been replaced by a link to another workspace.
  const workspaceRoot = await realpath(project.path)
  if (workspaceRoot !== project.path || !(await lstat(workspaceRoot)).isDirectory()) {
    throw new Error('Workspace root changed')
  }
  const legacy = workspaceRoot === legacyWorkspaceRoot
  const config = await readProjectConfig(workspaceRoot)
  // A project that never chose a folder keeps the original sample filename in
  // the compiler workspace; every other project saves into its configured
  // design directory.
  const canvasFile = legacy && !config.configured
    ? 'design/pages/mcp-center.op'
    : join(config.designDir, 'ui.op').split('\\').join('/')
  return {
    workspaceId, workspaceRoot, canvasFile, sourcePath: join(workspaceRoot, canvasFile),
    assetDir: config.assetDir, designDir: config.designDir, config,
    historyFile: legacy ? 'mcp-center.history.json' : 'ui.history.json',
    ownerSessionId: 'uic-sidebar-' + workspaceId, projectTitle: project.title,
  }
}

// Check each parent before descending; recursive mkdir would follow an
// existing link inside a workspace.
export async function projectDirectory(workspaceRoot, segments, create) {
  if (await realpath(workspaceRoot) !== workspaceRoot) throw new Error('Workspace root changed')
  let dir = workspaceRoot
  for (const segment of segments) {
    dir = join(dir, segment)
    if (create) {
      try { await mkdir(dir, { mode: 0o700 }) }
      catch (error) { if (error.code !== 'EEXIST') throw error }
    }
    if (!(await lstat(dir)).isDirectory() || await realpath(dir) !== dir) throw new Error('Invalid project directory')
  }
  return dir
}

// Publish a complete blank OpenPencil document only on a project's first
// explicit open. A simultaneous opener or an existing file always wins.
export async function ensureProjectCanvas(binding) {
  if (!binding.canvasFile.endsWith('/ui.op')) return
  const segments = binding.canvasFile.split('/').slice(0, -1)
  const directory = await projectDirectory(binding.workspaceRoot, segments, true)
  try {
    const stat = await lstat(binding.sourcePath)
    if (!stat.isFile()) throw new Error('Invalid project design file')
    return
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const tmp = join(directory, '.ui-' + randomUUID() + '.tmp')
  const handle = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644)
  try {
    try { await handle.writeFile(JSON.stringify({ version: '1.0.0', children: [] }, null, 2) + '\n') }
    finally { await handle.close() }
    if (await realpath(directory) !== directory) throw new Error('Design directory changed')
    try { await link(tmp, binding.sourcePath) }
    catch (error) { if (error.code !== 'EEXIST') throw error }
  } finally {
    await unlink(tmp)
  }
}
