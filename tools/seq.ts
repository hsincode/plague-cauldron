// Scripted browser session for visual tests: one page, a list of steps, several screenshots.
// usage: bun tools/seq.ts <url> <outDir> [width=608] [height=1080] -- <step>...
//   w=<ms>          wait (the game keeps running in real time)
//   js=<expr>       evaluate in the page and print the JSON result, e.g. js=__game.cheat.gold(500)
//   s=<name>        screenshot to <outDir>/<name>.png
//   fps=<ms>        measure rendered frames per second over that long (prints fps and the worst frame gap)
//   key=<Code>:<ms> hold a key (e.g. key=KeyD:800)
// CHROMIUM_PATH names the browser to launch (default /usr/sbin/chromium).
// example: bun tools/seq.ts "http://localhost:5174/?nostart=1" shots/x -- w=1500 s=start js="__game.cheat.drive(-1,0)" w=900 s=moved
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright-core'

const argv = process.argv.slice(2)
const cut = argv.indexOf('--')
const [url, outDir, w = '608', h = '1080'] = cut < 0 ? argv : argv.slice(0, cut)
const steps = cut < 0 ? [] : argv.slice(cut + 1)
if (!url || !outDir) throw new Error('usage: bun tools/seq.ts <url> <outDir> [w] [h] -- <step>...')
mkdirSync(outDir, { recursive: true })
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/usr/sbin/chromium',
  headless: true,
  args: ['--use-angle=gl', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--no-sandbox'],
})
const page = await browser.newPage({ viewport: { width: +w, height: +h } })
page.on('console', m => {
  if (m.type() === 'error' || m.type() === 'warning') console.log('[console]', m.type(), m.text())
})
page.on('pageerror', e => console.log('[pageerror]', e.message))
await page.goto(url)
for (const step of steps) {
  const eq = step.indexOf('=')
  const cmd = step.slice(0, eq)
  const arg = step.slice(eq + 1)
  if (cmd === 'w') await page.waitForTimeout(+arg)
  else if (cmd === 'js') console.log('[eval]', JSON.stringify(await page.evaluate(arg)))
  else if (cmd === 's') await page.screenshot({ path: `${outDir}/${arg}.png` })
  else if (cmd === 'key') {
    const [code, ms] = arg.split(':')
    await page.keyboard.down(code!)
    await page.waitForTimeout(+(ms ?? 200))
    await page.keyboard.up(code!)
  } else if (cmd === 'fps') {
    const r = await page.evaluate(
      ms =>
        new Promise(res => {
          let n = 0
          let worst = 0
          let last = performance.now()
          const t0 = last
          const tick = (now: number) => {
            n++
            worst = Math.max(worst, now - last)
            last = now
            if (now - t0 < ms) requestAnimationFrame(tick)
            else res({ fps: Math.round((n * 1000) / (now - t0)), worstGapMs: Math.round(worst) })
          }
          requestAnimationFrame(tick)
        }),
      +arg,
    )
    console.log('[fps]', JSON.stringify(r))
  } else throw new Error(`unknown step ${step}`)
}
await browser.close()
