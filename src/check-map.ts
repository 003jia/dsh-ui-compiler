import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Ajv } from 'ajv'
import type { InventoryProp, PrimitivesInventory } from './inventory.ts'

type Literal = string | number | boolean
type PropMapping = { type?: 'string' | 'number' | 'boolean'; values?: Literal[]; default?: Literal }
type ComponentMapping = { ignore: true } | {
  import: { from: string; name: string }
  props: Record<string, PropMapping>
}
type CompilerMap = {
  packages: { primitives: string; theme: string }
  components: Record<string, ComponentMapping>
}
type DesignNode = { name?: string; reusable?: boolean; children?: DesignNode[] }

function readJson(path: string) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function collectMasters(nodes: DesignNode[], names: Set<string>): void {
  for (const node of nodes) {
    if (node.reusable && node.name) names.add(node.name.split(' · ', 1)[0])
    if (node.children) collectMasters(node.children, names)
  }
}

function verifyProp(location: string, rule: PropMapping, prop: InventoryProp): string[] {
  const problems: string[] = []
  if (rule.type) {
    const matchesType = prop.values?.length
      ? prop.values.every(value => typeof value === rule.type)
      : prop.type.split(' | ').filter(type => type !== 'undefined').includes(rule.type)
    if (!matchesType) problems.push(`${location}: expected ${rule.type}, declared ${prop.type}`)
  }

  for (const value of [...(rule.values ?? []), ...('default' in rule ? [rule.default] : [])]) {
    if (prop.values && !prop.values.some(allowed => Object.is(allowed, value))) {
      problems.push(`${location}: ${JSON.stringify(value)} is outside the declared values ${prop.values.map(value => JSON.stringify(value)).join(', ')}`)
    }
    if (rule.type && typeof value !== rule.type) {
      problems.push(`${location}: ${JSON.stringify(value)} is not a ${rule.type}`)
    }
  }
  if (rule.values && 'default' in rule && !rule.values.some(value => Object.is(value, rule.default))) {
    problems.push(`${location}: default must be one of the mapped values`)
  }
  return problems
}

export function checkMap(projectRoot: string, inventory: PrimitivesInventory) {
  const schema = readJson(join(projectRoot, 'schemas/map.schema.json'))
  const mapping: unknown = readJson(join(projectRoot, 'ui-compiler.map.json'))
  const ajv = new Ajv({ allErrors: true })
  const validate = ajv.compile<CompilerMap>(schema)
  if (!validate(mapping)) throw new Error(ajv.errorsText(validate.errors))

  const problems: string[] = []
  const expectedPrimitives = `${inventory.package.name}@${inventory.package.version}`
  if (mapping.packages.primitives !== expectedPrimitives) {
    problems.push(`packages.primitives: expected ${expectedPrimitives}`)
  }

  const theme = readJson(join(projectRoot, 'node_modules/@deepseek-ai/dsh-client-ui-theme/package.json'))
  if (mapping.packages.theme !== `${theme.name}@${theme.version}`) {
    problems.push(`packages.theme: expected ${theme.name}@${theme.version}`)
  }

  for (const [name, component] of Object.entries(mapping.components)) {
    if ('ignore' in component) continue
    const target = inventory.components[component.import.name]
    if (component.import.from !== inventory.package.name || !target) {
      problems.push(`${name}: unknown import ${component.import.name} from ${component.import.from}`)
      continue
    }
    for (const [propName, rule] of Object.entries(component.props)) {
      const prop = target.props[propName]
      const location = `${name}.${propName}`
      if (!prop) problems.push(`${location}: unknown prop`)
      else problems.push(...verifyProp(location, rule, prop))
    }
  }

  const kitPath = join(projectRoot, 'design/kit')
  const kitFiles = readdirSync(kitPath).filter(name => name.endsWith('.op')).sort()
  const masters = new Set<string>()
  for (const file of kitFiles) {
    const document = readJson(join(kitPath, file))
    const roots = document.pages
      ? document.pages.flatMap((page: { children?: DesignNode[] }) => page.children ?? [])
      : document.children ?? []
    collectMasters(roots, masters)
  }
  if (masters.size === 0) problems.push('design/kit contains no reusable component definitions')
  for (const name of masters) {
    if (!Object.hasOwn(mapping.components, name)) problems.push(`${name}: no map entry or explicit ignore`)
  }
  if (problems.length) throw new Error(problems.join('\n'))
  return { mapped: Object.keys(mapping.components).length, kitComponents: masters.size }
}
