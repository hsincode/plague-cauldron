// Static server for the production build. usage: bun tools/preview.ts [dir=dist] [port=5175]
import { join, normalize } from 'node:path'

const [dir = 'dist', port = '5175'] = process.argv.slice(2)
Bun.serve({
  port: +port,
  async fetch(req) {
    let path = normalize(decodeURIComponent(new URL(req.url).pathname))
    if (path.endsWith('/')) path += 'index.html'
    const file = Bun.file(join(dir, path))
    return (await file.exists()) ? new Response(file, { headers: { 'cache-control': 'no-store' } }) : new Response('not found', { status: 404 })
  },
})
console.log(`${dir} on http://localhost:${port}`)
