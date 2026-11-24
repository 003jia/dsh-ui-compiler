import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, relative, resolve, sep } from 'node:path'
import ts from 'typescript'

const packageName = '@deepseek-ai/dsh-client-ui-primitives'

type Declaration = {
  file: string
  line: number
}

type Literal = string | number | boolean

export type InventoryProp = {
  type: string
  required: boolean
  declaration: Declaration
  values?: Literal[]
}

export type PrimitivesInventory = {
  schemaVersion: 1
  package: { name: string; version: string; declarations: string }
  components: Record<string, { declaration: Declaration; props: Record<string, InventoryProp> }>
}

function byName(left: ts.Symbol, right: ts.Symbol): number {
  return left.name < right.name ? -1 : Number(left.name > right.name)
}

function displayPath(fileName: string, packageRoot: string): string {
  const packageRelative = relative(packageRoot, fileName)
  if (!packageRelative.startsWith(`..${sep}`)) return packageRelative.split(sep).join('/')
  return fileName.split(`${sep}node_modules${sep}`).at(-1)!.split(sep).join('/')
}

function describeDeclaration(node: ts.Declaration, packageRoot: string): Declaration {
  const source = node.getSourceFile()
  return {
    file: displayPath(source.fileName, packageRoot),
    line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
  }
}

// The checker may qualify a type with an absolute pnpm dependency path.
// Persist the package import so the inventory is independent of the checkout.
function portableType(type: string): string {
  return type.replace(/import\("(?:\/|[A-Za-z]:\/)[^"]*\/node_modules\/([^"]+)"\)/gu, 'import("$1")')
}

function returnsReactElement(type: ts.Type): boolean {
  const symbol = type.aliasSymbol ?? type.getSymbol()
  if (symbol && ['ReactElement', 'ReactNode', 'Element'].includes(symbol.name)) {
    if (symbol.getDeclarations()?.some(node => node.getSourceFile().fileName.includes('/@types/react/'))) {
      return true
    }
  }
  return type.isUnion() && type.types.some(returnsReactElement)
}

function finiteValues(type: ts.Type, checker: ts.TypeChecker): Literal[] | undefined {
  const members = type.isUnion() ? type.types : [type]
  const values: Literal[] = []
  for (const member of members) {
    if (member.flags & ts.TypeFlags.Undefined) continue
    if (member.isStringLiteral() || member.isNumberLiteral()) {
      values.push(member.value)
    } else if (member.flags & ts.TypeFlags.BooleanLiteral) {
      values.push(checker.typeToString(member) === 'true')
    } else {
      return undefined
    }
  }
  return values.length > 0 ? values : undefined
}

export function generateInventory(projectRoot: string): PrimitivesInventory {
  const root = resolve(projectRoot)
  const require = createRequire(resolve(root, 'package.json'))
  const packageFile = require.resolve(`${packageName}/package.json`)
  const packageRoot = dirname(packageFile)
  const manifest = JSON.parse(readFileSync(packageFile, 'utf8'))
  const entry = resolve(packageRoot, manifest.types)
  const program = ts.createProgram([entry], {
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    skipLibCheck: true,
    strict: true,
    target: ts.ScriptTarget.ESNext,
    types: ['react'],
    typeRoots: [resolve(root, 'node_modules/@types')],
  })
  const source = program.getSourceFile(entry)
  if (!source) throw new Error(`Cannot read primitive declarations: ${entry}`)
  if (program.getOptionsDiagnostics().some(item => item.code === 2688)) {
    throw new Error('Cannot load React types for component inventory')
  }
  const checker = program.getTypeChecker()
  const packageModule = checker.getSymbolAtLocation(source)
  if (!packageModule) throw new Error(`Missing primitive module exports: ${entry}`)

  const components: PrimitivesInventory['components'] = {}
  for (const publicExport of checker.getExportsOfModule(packageModule).sort(byName)) {
    if (!/^[A-Z]/.test(publicExport.name)) continue
    const component = publicExport.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(publicExport)
      : publicExport
    const declaration = component.valueDeclaration
    if (!declaration) continue
    const type = checker.getTypeOfSymbolAtLocation(component, declaration)
    const signature = type.getCallSignatures().find(call => returnsReactElement(call.getReturnType()))
    if (!signature) continue

    const props: Record<string, InventoryProp> = {}
    const parameter = signature.getParameters()[0]
    if (parameter) {
      const parameterType = checker.getTypeOfSymbolAtLocation(parameter, declaration)
      for (const prop of checker.getPropertiesOfType(parameterType).sort(byName)) {
        const origin = prop.valueDeclaration ?? prop.declarations?.[0]
        if (!origin) continue
        const propType = checker.getTypeOfSymbolAtLocation(prop, origin)
        const values = finiteValues(propType, checker)
        props[prop.name] = {
          type: portableType(checker.typeToString(propType, origin, ts.TypeFormatFlags.NoTruncation)),
          required: !(prop.flags & ts.SymbolFlags.Optional),
          declaration: describeDeclaration(origin, packageRoot),
          ...(values ? { values } : {}),
        }
      }
    }
    components[publicExport.name] = { declaration: describeDeclaration(declaration, packageRoot), props }
  }
  if (Object.keys(components).length === 0) {
    throw new Error(`No exported React components found in ${packageName}@${manifest.version}`)
  }

  const inventory: PrimitivesInventory = {
    schemaVersion: 1,
    package: { name: manifest.name, version: manifest.version, declarations: displayPath(entry, packageRoot) },
    components,
  }
  const destination = resolve(root, 'tokens/primitives.inventory.json')
  mkdirSync(dirname(destination), { recursive: true })
  const temporary = `${destination}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(inventory, null, 2)}\n`)
    renameSync(temporary, destination)
  } finally {
    rmSync(temporary, { force: true })
  }
  return inventory
}
