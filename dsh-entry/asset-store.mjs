import { constants } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { link, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'

// Project-local configuration and uploaded assets share one private directory.
// Paths are always relative to the registered DSH workspace and are revalidated
// on every use; a caller never supplies an absolute host path.

export const DEFAULT_DESIGN_DIR = 'design/pages'
export const DEFAULT_ASSET_DIR = 'design/assets'
export const CONFIG_FILE = 'config.json'

const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_FILE_BYTES = 32 * 1024 * 1024
const MAX_TEXT_BYTES = 32 * 1024
const SEGMENT = /^[^/\\\0]+$/u

function fail(message) {
  return Object.assign(new Error(message), { code: 'invalid_config' })
}

function cleanSegment(value) {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (text === '' || text === '.' || text === '..' || !SEGMENT.test(text) || text.includes('\0')) return undefined
  return text
}

/** Parse and validate one project-relative directory such as `design/pages`. */
export function normalizeDirectory(value, fallback) {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || value.trim() === '' || isAbsolute(value) || value.includes('\\')) {
    throw fail('Directory must be a non-empty project-relative path')
  }
  const segments = value.split('/')
  if (segments.length > 8) throw fail('Directory is too deep')
  const clean = segments.map(cleanSegment)
  if (clean.some(segment => segment === undefined)) throw fail('Directory contains an invalid segment')
  return clean.join('/')
}

/** Read the project's target-folder configuration, falling back to defaults. */
export async function readProjectConfig(workspaceRoot) {
  const defaults = { designDir: DEFAULT_DESIGN_DIR, assetDir: DEFAULT_ASSET_DIR, configured: false }
  let text
  try {
    text = await readFile(join(workspaceRoot, '.dsh', 'ui-compiler', CONFIG_FILE), 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return defaults
    throw error
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw fail('Project configuration is not valid JSON')
  }
  return {
    designDir: normalizeDirectory(parsed?.designDir, DEFAULT_DESIGN_DIR),
    assetDir: normalizeDirectory(parsed?.assetDir, DEFAULT_ASSET_DIR),
    configured: true,
  }
}

// Check each parent before creating the next one so a symlink inside the
// project cannot redirect a write outside it.
async function ensureDirectory(workspaceRoot, relativeDirectory) {
  const root = await realpath(workspaceRoot)
  if (root !== workspaceRoot) throw fail('Workspace root changed')
  let current = root
  for (const segment of relativeDirectory.split('/')) {
    current = join(current, segment)
    try { await mkdir(current, { mode: 0o700 }) }
    catch (error) { if (error.code !== 'EEXIST') throw error }
    const info = await lstat(current)
    if (!info.isDirectory() || await realpath(current) !== current) throw fail('Invalid project directory')
  }
  return current
}

/** Persist the target-folder configuration atomically inside the project. */
export async function writeProjectConfig(workspaceRoot, input) {
  const config = {
    designDir: normalizeDirectory(input?.designDir, DEFAULT_DESIGN_DIR),
    assetDir: normalizeDirectory(input?.assetDir, DEFAULT_ASSET_DIR),
  }
  const directory = await ensureDirectory(workspaceRoot, '.dsh/ui-compiler')
  const temporary = join(directory, CONFIG_FILE + '.' + randomUUID())
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  try {
    try { await file.writeFile(JSON.stringify(config, null, 2) + '\n') } finally { await file.close() }
    await rename(temporary, join(directory, CONFIG_FILE))
  } finally {
    await rm(temporary, { force: true })
  }
  return config
}

function safeFilename(name) {
  const text = typeof name === 'string' ? name.normalize('NFKC') : ''
  const base = basename(text.replace(/[\\/]+/gu, '-')).replace(/[\0-\x1f:]/gu, '').trim()
  const cleaned = base.replace(/^\.+/, '').slice(0, 180)
  return cleaned === '' ? 'upload' : cleaned
}

function imageMime(value) {
  return typeof value === 'string' && /^image\/(?:png|jpeg|webp|gif|svg\+xml)$/u.test(value)
}

const MIME_BY_EXTENSION = new Map([
  ['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['webp', 'image/webp'],
  ['gif', 'image/gif'], ['svg', 'image/svg+xml'], ['pdf', 'application/pdf'],
  ['txt', 'text/plain'], ['md', 'text/markdown'], ['json', 'application/json'],
  ['js', 'text/javascript'], ['mjs', 'text/javascript'], ['ts', 'text/plain'], ['tsx', 'text/plain'],
  ['css', 'text/css'], ['html', 'text/html'], ['yml', 'text/plain'], ['yaml', 'text/plain'],
])

/** Infer a display MIME type from a stored file name. */
export function mimeForName(name) {
  const extension = typeof name === 'string' ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
  return MIME_BY_EXTENSION.get(extension) ?? 'application/octet-stream'
}

/**
 * Store one uploaded file under the configured asset directory.
 * @param workspaceRoot - canonical project root.
 * @param assetDir - validated project-relative asset directory.
 * @param input - file name, MIME type, and raw bytes.
 * @returns the asset identity and its project-relative path.
 */
export async function saveAsset(workspaceRoot, assetDir, { name, mimeType, bytes }) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) throw fail('The uploaded file is empty')
  if (bytes.length > (imageMime(mimeType) ? MAX_IMAGE_BYTES : MAX_FILE_BYTES)) throw fail('The uploaded file is too large')
  const directory = await ensureDirectory(workspaceRoot, assetDir)
  const filename = safeFilename(name)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const stored = `${sha256.slice(0, 16)}-${filename}`
  const target = join(directory, stored)
  // Publish through an atomic hard link: concurrent uploads of the same bytes
  // never expose a partially written file to each other.
  const temporary = join(directory, '.asset-' + randomUUID())
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  try {
    try { await handle.writeFile(bytes) } finally { await handle.close() }
    try { await link(temporary, target) }
    catch (error) { if (error.code !== 'EEXIST') throw error }
  } finally {
    await rm(temporary, { force: true })
  }
  const existing = await readFile(target)
  if (createHash('sha256').update(existing).digest('hex') !== sha256) throw fail('Asset name collision')
  if (await realpath(directory) !== directory) throw fail('Asset directory changed')
  return {
    id: sha256,
    path: join(assetDir, stored).split(sep).join('/'),
    name: filename,
    mimeType: typeof mimeType === 'string' ? mimeType : 'application/octet-stream',
    bytes: bytes.length,
    sha256,
  }
}

/** Resolve one stored asset by its full SHA-256 identity. */
export async function findAsset(workspaceRoot, assetDir, id) {
  if (typeof id !== 'string' || !/^[a-f0-9]{64}$/u.test(id)) throw fail('Invalid asset id')
  const directory = await ensureDirectory(workspaceRoot, assetDir)
  const entries = await readdir(directory, { withFileTypes: true })
  const match = entries.find(entry => entry.isFile() && !entry.isSymbolicLink() && entry.name.startsWith(id.slice(0, 16) + '-'))
  if (match === undefined) return undefined
  const path = join(directory, match.name)
  const bytes = await readFile(path)
  if (createHash('sha256').update(bytes).digest('hex') !== id) throw fail('Asset content changed')
  const name = match.name.slice(id.slice(0, 16).length + 1)
  return {
    id,
    path: join(assetDir, match.name).split(sep).join('/'),
    name,
    mimeType: mimeForName(name),
    bytes,
  }
}

/** Read a bounded text excerpt for a text-like attachment. */
export function textExcerpt(bytes) {
  if (bytes.length > MAX_TEXT_BYTES) bytes = bytes.subarray(0, MAX_TEXT_BYTES)
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

/** Build the self-contained data URL used by document image layers. */
export function assetDataUrl(mimeType, bytes) {
  if (!imageMime(mimeType) || bytes.length > MAX_IMAGE_BYTES) return undefined
  return `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`
}

/** Whether a stored MIME type can be shown to a vision model. */
export function visionMime(mimeType) {
  return typeof mimeType === 'string' && /^image\/(?:png|jpeg|webp|gif)$/u.test(mimeType)
}
