import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'
import { allowsLocalRequest } from './localAccess.ts'

const MAX_BYTES = 50 * 1024 * 1024

export function localImageBackupPlugin(rootDir: string): Plugin {
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const reply = (status: number, body: object) => {
      res.statusCode = status
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(JSON.stringify(body))
    }
    try {
      if (!allowsLocalRequest(req)) {
        reply(403, { error: '仅允许本机或内网同源请求保存图片' })
        return
      }
      if (req.method !== 'POST') {
        reply(405, { error: '仅支持 POST' })
        return
      }
      const mime = req.headers['content-type']?.split(';')[0]
      const extensions: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }
      const ext = mime && extensions[mime]
      if (!ext) {
        reply(415, { error: '仅支持 PNG、JPEG、WebP 图片' })
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > MAX_BYTES) {
          reply(413, { error: '图片超过 50 MB，无法备份' })
          return
        }
        chunks.push(Buffer.from(chunk))
      }
      const bytes = Buffer.concat(chunks)
      const valid = ext === 'png' ? bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
        : ext === 'jpg' ? bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))
          : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
      if (!valid) {
        reply(400, { error: '图片内容与格式不符' })
        return
      }
      const filename = `character-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.${ext}`
      const directory = path.join(rootDir, 'outputs')
      await mkdir(directory, { recursive: true })
      await writeFile(path.join(directory, filename), bytes, { flag: 'wx' })
      reply(201, { path: `outputs/${filename}` })
    } catch (error) {
      console.error('[local-image-backup]', error)
      if (!res.headersSent) reply(500, { error: '本地备份失败，请检查 outputs 目录写入权限和磁盘空间' })
    }
  }
  const install = (server: { middlewares: { use: (handler: (req: IncomingMessage, res: ServerResponse, next: () => void) => void) => void } }) => {
    server.middlewares.use((req, res, next) => {
      if (req.url?.split('?')[0] !== '/api/local-image-backup') return next()
      void handle(req, res)
    })
  }
  return { name: 'local-image-backup', configureServer: install, configurePreviewServer: install }
}
