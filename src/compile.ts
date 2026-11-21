import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { readOpDocument } from './adapters/op/index.ts'
import { emitDshReact, type CompilerMap } from './emit/dsh-react/index.ts'

type CompileOptions = {
  projectRoot: string
  design: string
  frame: string
  name: string
  out: string
  strict: boolean
  nativePreviewLayout?: boolean
}

type Manifest = {
  version: 1
  inputHash: string
  frameIds: string[]
  outputs: Record<string, string>
}

const manifestName = '.uic-manifest.json'

function hash(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function json(data: unknown): string {
  return `${JSON.stringify(data, null, 2)}\n`
}

function readOptional(path: string): Buffer | undefined {
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (!stat) return undefined
  if (!stat.isFile()) throw new Error(`Expected a regular file: ${path}`)
  return readFileSync(path)
}

function writeAtomic(path: string, contents: string | Buffer): void {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, contents, { flag: 'wx' })
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}

function readManifest(contents: Buffer | undefined): Manifest | undefined {
  if (!contents) return undefined
  const manifest = JSON.parse(contents.toString('utf8'))
  if (
    manifest?.version !== 1 ||
    typeof manifest.inputHash !== 'string' ||
    !Array.isArray(manifest.frameIds) ||
    !manifest.outputs ||
    typeof manifest.outputs !== 'object' ||
    Array.isArray(manifest.outputs)
  ) throw new Error('Invalid .uic-manifest.json. Inspect the manifest before rebuilding.')
  return manifest
}

function writeOutput(out: string, files: Record<string, string>, manifest: Manifest): void {
  mkdirSync(out, { recursive: true })
  const lockPath = join(out, '.uic-lock')
  try {
    mkdirSync(lockPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Output directory is locked: ${out}`, { cause: error })
    }
    throw error
  }

  try {
    const manifestPath = join(out, manifestName)
    const previousManifest = readManifest(readOptional(manifestPath))
    const previous = new Map<string, Buffer | undefined>()
    for (const key of Object.keys(previousManifest?.outputs ?? {})) {
      if (!Object.hasOwn(files, key)) {
        throw new Error(`Output conflict: ${key} belongs to another generation in ${out}`)
      }
    }
    for (const key of Object.keys(files)) {
      if (basename(key) !== key || !key.includes('.generated.')) {
        throw new Error(`Invalid generated filename: ${key}`)
      }
      const current = readOptional(join(out, key))
      if (current && previousManifest?.outputs[key] !== hash(current)) {
        throw new Error(`Output conflict: refusing to overwrite ${join(out, key)}`)
      }
      previous.set(key, current)
    }

    const replaced: string[] = []
    try {
      for (const [key, content] of Object.entries(files)) {
        if (previous.get(key)?.equals(Buffer.from(content))) continue
        writeAtomic(join(out, key), content)
        replaced.push(key)
      }
      const serializedManifest = json(manifest)
      if (!readOptional(manifestPath)?.equals(Buffer.from(serializedManifest))) {
        writeAtomic(manifestPath, serializedManifest)
      }
    } catch (error) {
      for (const key of replaced.reverse()) {
        const backup = previous.get(key)
        if (backup === undefined) rmSync(join(out, key))
        else writeAtomic(join(out, key), backup)
      }
      throw error
    }
  } finally {
    rmSync(lockPath, { recursive: true })
  }
}

export function compileDesign(options: CompileOptions) {
  const design = resolve(options.design)
  const out = resolve(options.out)
  const mapping: CompilerMap = JSON.parse(readFileSync(join(options.projectRoot, 'ui-compiler.map.json'), 'utf8'))
  const inputHash = hash(readFileSync(design))
  const page = readOpDocument(design, options.frame, { nativePreviewLayout: options.nativePreviewLayout })
  if (inputHash !== hash(readFileSync(design))) throw new Error('Design changed while being read. Save and retry.')

  const { files, report } = emitDshReact(page, mapping, options.name, { nativePreviewLayout: options.nativePreviewLayout })
  const frameIds = page.frames.map(frame => frame.node.id)
  const slug = options.name.replace(/View$/, '').replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
  if (!/^[a-z][a-z0-9-]*$/.test(slug)) throw new Error('Component name must be a PascalCase identifier')
  const reportDirectory = join(options.projectRoot, 'artifacts', 'compile', slug)
  const reportPath = join(reportDirectory, 'report.json')
  const strictErrors = options.strict
    ? report.warnings.filter(warning => !warning.message.startsWith('翻译待补'))
    : []
  const result = {
    source: relative(options.projectRoot, design),
    inputHash,
    frameIds,
    ...report,
    coverage: report.total === 0 ? 0 : report.covered / report.total,
    errorCount: strictErrors.length,
  }

  if (strictErrors.length === 0) {
    const outputs = Object.fromEntries(Object.entries(files).map(([key, value]) => [key, hash(value)]))
    writeOutput(out, files, { version: 1, inputHash, frameIds, outputs })
  }
  mkdirSync(reportDirectory, { recursive: true })
  writeAtomic(reportPath, json(result))
  if (strictErrors.length) throw new Error(`Strict compile reported ${strictErrors.length} errors. See ${reportPath}`)
  return { ...result, reportPath }
}
