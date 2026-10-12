// Writes dist/THIRD-PARTY-NOTICES.txt, the licences of what the bundle contains: the minifier drops the three.js
// banner and the font is inlined without its licence text. `bun run build` runs it after the bundler.
import { readFileSync, writeFileSync } from 'node:fs'

const BUNDLED = [
  ['three.js', 'node_modules/three/LICENSE'],
  ['Lilita One (the HUD and title font)', 'src/ui/fonts/LilitaOne-OFL.txt'],
] as const

const rule = '='.repeat(78)
let out = 'Plague Cauldron bundles the following third-party work.\n'
for (const [name, file] of BUNDLED) out += `\n${rule}\n${name}\n${rule}\n\n${readFileSync(file, 'utf8').trim()}\n`
writeFileSync('dist/THIRD-PARTY-NOTICES.txt', out)
