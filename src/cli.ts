import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { checkMap } from './check-map.ts'
import { generateInventory } from './inventory.ts'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const usage = [
  'uic inventory',
  'uic tokens [--source <theme.css>]',
  'uic check-map',
  'uic compile <design.op> --frame <page[/state]> --name <PageView> --out <directory> [--strict]',
  'uic verify <design.op> --frame <page[/state]> [--theme light,dark] [--max-diff 0.03]',
].join('\n')

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      source: { type: 'string' },
      frame: { type: 'string' },
      name: { type: 'string' },
      out: { type: 'string' },
      strict: { type: 'boolean' },
      theme: { type: 'string' },
      'max-diff': { type: 'string' },
    },
  })
  const [command] = positionals
  if (values.help || !command) {
    console.log(usage)
    return
  }
  const compileFlags = [values.name, values.out, values.strict].some(value => value !== undefined)
  const targeted = command === 'compile' || command === 'verify'
  const verifyFlags = values.theme !== undefined || values['max-diff'] !== undefined
  if (
    positionals.length !== (targeted ? 2 : 1) ||
    (values.source !== undefined && command !== 'tokens') ||
    (compileFlags && command !== 'compile') ||
    (verifyFlags && command !== 'verify') ||
    (values.frame !== undefined && !targeted)
  ) {
    throw new Error(`Invalid arguments\n${usage}`)
  }
  switch (command) {
    case 'inventory': {
      const inventory = generateInventory(projectRoot)
      console.log(`Wrote tokens/primitives.inventory.json (${Object.keys(inventory.components).length} components)`)
      break
    }
    case 'tokens': {
      const { generateTokens } = await import('./tokens.ts')
      generateTokens(projectRoot, values.source)
      console.log('Wrote tokens/dsw.tokens.json')
      break
    }
    case 'check-map': {
      const result = checkMap(projectRoot, generateInventory(projectRoot))
      console.log(`Map checked (${result.mapped} entries, ${result.kitComponents} design components)`)
      break
    }
    case 'compile': {
      if (!values.frame || !values.name || !values.out) throw new Error(usage)
      if (!/^[A-Z][A-Za-z0-9]*$/.test(values.name)) throw new Error('Component name must be a PascalCase identifier')
      const { compileDesign } = await import('./compile.ts')
      const result = compileDesign({
        projectRoot,
        design: positionals[1],
        frame: values.frame,
        name: values.name,
        out: values.out,
        strict: values.strict ?? false,
      })
      console.log(`Compiled ${result.covered}/${result.total} nodes (${(100 * result.coverage).toFixed(1)}%). Report: ${result.reportPath}`)
      break
    }
    case 'verify': {
      if (!values.frame) throw new Error(usage)
      const maxDiff = values['max-diff'] === undefined ? 0.03 : Number(values['max-diff'])
      if (!Number.isFinite(maxDiff) || maxDiff < 0 || maxDiff > 1 || values['max-diff']?.trim() === '') {
        throw new Error('--max-diff must be a ratio between 0 and 1')
      }
      const { verifyDesign } = await import('./verify/index.ts')
      const verification = await verifyDesign({
        projectRoot, design: positionals[1], frame: values.frame, theme: values.theme,
      })
      for (const item of verification.results) {
        if (item.status === 'compared') {
          console.log(`${item.state}/${item.theme} ${(item.diffRatio * 100).toFixed(2)}% changed`)
        } else console.error(`${item.state}/${item.theme}: ${item.error}`)
      }
      console.log(`Report: ${verification.reportPath}`)
      if (verification.errors.length) throw new Error('One or more comparisons could not be completed')
      if (verification.results.some(item => item.status === 'compared' && item.diffRatio > maxDiff)) {
        throw new Error(`Visual difference exceeds ${maxDiff * 100}%`)
      }
      break
    }
    default:
      throw new Error(`Unknown command ${command}\n${usage}`)
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
