import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer } from 'vite'
import { localCostumesPlugin } from './localCostumesPlugin.ts'

test('uploaded costumes persist, concurrent writes survive, invalid images and cross-origin writes fail', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pose-costumes-test-'))
  let server
  const launch = async () => {
    server = await createServer({ configFile: false, root, logLevel: 'silent', plugins: [localCostumesPlugin(root)], server: { host: '127.0.0.1', port: 0 } })
    await server.listen()
    return `http://127.0.0.1:${server.httpServer.address().port}`
  }
  try {
    let base = await launch()
    assert.deepEqual(await (await fetch(`${base}/api/local-costumes`)).json(), [])
    const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
    const post = (body, origin = base) => fetch(`${base}/api/local-costumes`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const input = { name: '米白针织衫', category: '秋季穿搭', tags: ['针织', '米白', '针织'], keywords: 'ivory knit', image }
    const responses = await Promise.all([post(input), post({ ...input, kind: '二次元', sensitive: true })])
    assert.ok(responses.every((r) => r.status === 201))
    const item = await responses[0].json()
    assert.equal(item.source, 'custom')
    assert.deepEqual(item.标签, ['针织', '米白'])
    assert.match(item.检索, /ivory knit/)
    assert.deepEqual(await readFile(path.join(root, item.原图)), Buffer.from(image.split(',')[1], 'base64'))
    assert.equal((await post(input, 'https://example.com')).status, 403)
    assert.equal((await post({ ...input, image: 'data:image/png;base64,YWJj' })).status, 400)
    assert.equal((await post({ ...input, name: '' })).status, 400)
    await server.close()
    base = await launch()
    const items = await (await fetch(`${base}/api/local-costumes`)).json()
    assert.equal(items.length, 2)
    assert.ok(items.some((entry) => entry.敏感 && entry.一级分类 === '二次元'))
  } finally {
    if (server) await server.close()
    assert.ok(path.resolve(root).startsWith(path.join(path.resolve(tmpdir()), 'pose-costumes-test-')))
    await rm(root, { recursive: true, force: true })
  }
})
