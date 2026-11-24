// Inlines src/mesh.js and src/client.js into src/userscript.js behind the userscript metadata block.
// Set DOWNLOAD_URL to the raw URL of dist/onshape-mesh-export.user.js once it is hosted, so managers can auto-update.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

const root = new URL('..', import.meta.url)
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
const lib = ['src/mesh.js', 'src/client.js'].map((f) => readFileSync(new URL(f, root), 'utf8').replace(/^export /gm, '')).join('\n')
const ui = readFileSync(new URL('src/userscript.js', root), 'utf8')
const dl = process.env.DOWNLOAD_URL

const meta = [
  '// ==UserScript==',
  '// @name         Onshape mesh export',
  '// @namespace    onshape-mesh-export',
  `// @version      ${pkg.version}`,
  `// @description  ${pkg.description}`,
  '// @match        https://cad.onshape.com/documents/*',
  '// @match        https://*.onshape.com/documents/*',
  '// @grant        none',
  '// @run-at       document-idle',
  `// @license      ${pkg.license}`,
  ...(dl ? [`// @downloadURL  ${dl}`, `// @updateURL    ${dl}`] : []),
  '// ==/UserScript==',
].join('\n')

const out = `${meta}\n\n(() => {\n'use strict'\n\n${lib}\n${ui}\n})()\n`
mkdirSync(new URL('dist/', root), { recursive: true })
writeFileSync(new URL('dist/onshape-mesh-export.user.js', root), out)
console.log(`dist/onshape-mesh-export.user.js ${out.length} bytes, v${pkg.version}`)
