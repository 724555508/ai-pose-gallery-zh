import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Plugin } from 'vite'
import { allowsLocalRequest } from './localAccess.ts'
import type { CostumeItem } from '../src/types/gallery.ts'

export function localCostumesPlugin(root: string): Plugin {
  const directory = path.join(root, '.local-costumes')
  const catalog = path.join(directory, 'catalog.json')
  let writes: Promise<unknown> = Promise.resolve()
  const read = async (): Promise<CostumeItem[]> => {
    try { const items = JSON.parse(await readFile(catalog, 'utf8')); if (!Array.isArray(items)) throw new Error('上传图库文件格式无效'); return items }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  }
  return {
    name: 'local-costumes',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== '/api/local-costumes') return next()
        const json = (status: number, body: unknown) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(body)) }
        void (async () => {
          if (!allowsLocalRequest(req, true)) { json(403, { error: '仅允许本机或内网同源请求' }); return }
          if (req.method === 'GET') { json(200, await read()); return }
          if (req.method !== 'POST') { json(405, { error: '不支持此请求' }); return }
          let length = 0
          const chunks: Buffer[] = []
          for await (const chunk of req) {
            length += chunk.length
            if (length > 28 * 1024 * 1024) { json(413, { error: '图片过大，单张最多 20 MB' }); return }
            chunks.push(Buffer.from(chunk))
          }
          const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          const text = (value: unknown, max: number) => typeof value === 'string' ? value.trim().slice(0, max) : ''
          const name = text(input.name, 120), category = text(input.category, 40)
          if (!name || !category) throw new Error('请填写服装名称和分类')
          const match = typeof input.image === 'string' && input.image.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=\r\n]+)$/)
          if (!match) throw new Error('请上传 PNG、JPEG 或 WebP 图片')
          const bytes = Buffer.from(match[2], 'base64')
          if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new Error('图片无效或超过 20 MB')
          const type = match[1]
          const valid = type === 'png' ? bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) : type === 'jpeg' ? bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex')) : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
          if (!valid) throw new Error('图片内容与格式不符')
          const id = `CUSTOM-${randomUUID()}`
          const image = `img/custom-costumes/${id}.${type === 'jpeg' ? 'jpg' : type}`
          const tags = Array.isArray(input.tags) ? [...new Set(input.tags.map((tag: unknown) => text(tag, 30)).filter(Boolean))].slice(0, 30) as string[] : []
          const keywords = text(input.keywords, 1000)
          const item: CostumeItem = { id, source: 'custom', 一级分类: input.kind === '二次元' ? '二次元' : '现实', 分类: category, 服装名称: name, 标签: tags, 关键词: keywords, 缩略图: image, 预览图: image, 原图: image, 敏感: input.sensitive === true, 检索: [id, name, category, ...tags, keywords].join(' ') }
          const save = writes.catch(() => {}).then(async () => {
            await mkdir(directory, { recursive: true })
            await mkdir(path.dirname(path.join(root, image)), { recursive: true })
            const items = await read()
            await writeFile(path.join(root, image), bytes, { flag: 'wx' })
            try { await writeFile(`${catalog}.tmp`, JSON.stringify([item, ...items], null, 2)); await rename(`${catalog}.tmp`, catalog) }
            catch (error) { await unlink(path.join(root, image)).catch(() => {}); throw error }
          })
          writes = save
          await save
          json(201, item)
        })().catch((error) => { if (!res.headersSent) json(400, { error: error instanceof Error ? error.message : '上传失败' }) })
      })
    },
  }
}
