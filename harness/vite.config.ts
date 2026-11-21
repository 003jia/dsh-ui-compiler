import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { defineConfig, type Plugin } from 'vite'

const require = createRequire(import.meta.url)
const primitives = '@deepseek-ai/dsh-client-ui-primitives'
const themePackage = '@deepseek-ai/dsh-client-ui-theme'
const themeModule = 'virtual:dsh-harness-theme'
const controls = ['Button', 'Input', 'Switch']
const version = '0.2.2-alpha.2'

function readPackageScript(name: string, entry: string) {
  const manifest = require.resolve(`${name}/package.json`)
  const metadata = JSON.parse(readFileSync(manifest, 'utf8'))
  if (metadata.version !== version) {
    throw new Error(`Harness expects ${name}@${version}, found ${metadata.version}`)
  }
  const path = resolve(dirname(manifest), 'lib', entry)
  return ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS)
}

function primitiveModule() {
  const source = readPackageScript(primitives, 'index.js')
  const styles = new Set(controls.map(name => `./${name}.module.css`))
  const declarations = new Map<string, string>()
  const styleImports: string[] = []
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const specifier = statement.moduleSpecifier.text
      if (styles.delete(specifier) && statement.importClause?.name) {
        const absolute = resolve(dirname(source.fileName), specifier)
        styleImports.push(`import ${statement.importClause.name.text} from ${JSON.stringify(absolute)};`)
      }
    }
    if (ts.isFunctionDeclaration(statement) && statement.name && controls.includes(statement.name.text)) {
      declarations.set(statement.name.text, statement.getText(source))
    }
    if (ts.isVariableStatement(statement)) {
      for (const item of statement.declarationList.declarations) {
        if (ts.isIdentifier(item.name) && controls.includes(item.name.text)) {
          declarations.set(item.name.text, statement.getText(source))
        }
      }
    }
  }
  if (styleImports.length !== controls.length || declarations.size !== controls.length) {
    throw new Error(`Could not find all preview controls and CSS modules in ${source.fileName}`)
  }

  // DSH ships one barrel. Use the installed declarations and CSS verbatim
  // without resolving the other controls' host-provided runtime dependencies.
  return [
    'import { forwardRef } from "react";',
    'import { jsx, jsxs } from "react/jsx-runtime";',
    'import clsx from "clsx";',
    ...styleImports,
    ...declarations.values(),
    `export { ${controls.join(', ')} };`,
  ].join('\n')
}

function themeCss() {
  const source = readPackageScript(themePackage, 'client.js')
  const names = ['base', 'corner_shape', 'design_platform', 'focus', 'scrollbar', 'gradient_shadow_text']
  const styles = new Map<string, string>()
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
        node.initializer && ts.isStringLiteral(node.initializer)) {
      styles.set(node.name.text, node.initializer.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return names.map(name => {
    const css = styles.get(`${name}_css_default`)
    if (!css) throw new Error(`Theme stylesheet ${name} is missing from ${source.fileName}`)
    return css
  }).join('\n')
}

function dshHarnessModules(): Plugin {
  const controlsId = '\0virtual:dsh-harness-primitives'
  const themeId = `\0${themeModule}`
  return {
    name: 'uic:dsh-harness-modules',
    enforce: 'pre',
    resolveId(id) {
      if (id === primitives) return controlsId
      if (id === themeModule) return themeId
    },
    load(id) {
      if (id === controlsId) return primitiveModule()
      if (id === themeId) return `export default ${JSON.stringify(themeCss())};`
    },
  }
}

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  esbuild: { jsx: 'automatic' },
  optimizeDeps: { exclude: [primitives] },
  plugins: [dshHarnessModules()],
})
