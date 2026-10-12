// usage: bun tools/shot.ts <url> <out.png> [width] [height] [waitMs] [evalJs]
// CHROMIUM_PATH names the browser to launch (default /usr/sbin/chromium).
import { chromium } from 'playwright-core'
const [url, out, w = '608', h = '1080', wait = '1500', js] = process.argv.slice(2)
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/usr/sbin/chromium',
  headless: true,
  args: ['--use-angle=gl', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--no-sandbox'],
})
const page = await browser.newPage({ viewport: { width: +w, height: +h } })
page.on('console', m => console.log('[console]', m.type(), m.text()))
page.on('pageerror', e => console.log('[pageerror]', e.message))
await page.goto(url)
await page.waitForTimeout(+wait)
if (js) console.log('[eval]', JSON.stringify(await page.evaluate(js)))
await page.screenshot({ path: out })
await browser.close()
