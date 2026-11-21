import { constants, copyFileSync, mkdirSync } from 'node:fs'

const pages = new URL('../design/pages/', import.meta.url)
mkdirSync(pages, { recursive: true })
try {
  copyFileSync(new URL('../examples/mcp-center.op', import.meta.url), new URL('mcp-center.op', pages), constants.COPYFILE_EXCL)
} catch (error) {
  if (error.code !== 'EEXIST') throw error
}
