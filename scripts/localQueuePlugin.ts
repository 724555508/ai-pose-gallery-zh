import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'
import { ComfyQueue } from './comfyQueue.ts'
import { allowsLocalRequest } from './localAccess.ts'
import type { QueueSubmission } from '../src/types/localQueue.ts'

export function localQueuePlugin(root: string, comfyUrl: string): Plugin {
  return {
    name: 'local-comfy-queue',
    async configureServer(server) {
      const queue = new ComfyQueue(root)
      await queue.start()
      const close = server.close.bind(server)
      server.close = async () => { await queue.stop(); return close() }
      server.httpServer?.once('close', () => void queue.stop())
      const handle = async (req: IncomingMessage, res: ServerResponse) => {
        const json = (status: number, data: unknown) => {
          res.statusCode = status
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.setHeader('Cache-Control', 'no-store')
          res.end(JSON.stringify(data))
        }
        try {
          if (!allowsLocalRequest(req, true)) {
            json(403, { error: '仅允许本机或内网同源请求操作队列' }); return
          }
          const url = new URL(req.url!, `http://${req.headers.host}`)
          const route = url.pathname.slice('/api/local-queue'.length)
          if (req.method === 'GET' && route === '') { json(200, queue.state); return }
          const match = route.match(/^\/([\da-f-]{36})(\/image)?$/i)
          if (req.method === 'GET' && match) {
            const job = queue.state.jobs.find((item) => item.id === match[1])
            if (!job) { json(404, { error: '任务不存在' }); return }
            if (match[2]) {
              if (job.status !== 'completed' || !job.output || path.basename(job.output) !== job.output) { json(404, { error: '图片尚未生成' }); return }
              const bytes = await readFile(path.join(root, 'outputs', job.output))
              res.setHeader('Content-Type', job.output.endsWith('.jpg') ? 'image/jpeg' : job.output.endsWith('.webp') ? 'image/webp' : 'image/png')
              res.end(bytes); return
            }
            const payload = await queue.payload(job.id)
            json(200, { job, snapshot: payload.snapshot }); return
          }
          if (req.method !== 'POST') { json(405, { error: '不支持此请求' }); return }
          let size = 0
          const chunks: Buffer[] = []
          for await (const chunk of req) {
            size += chunk.length
            if (size > 100 * 1024 * 1024) { json(413, { error: '任务快照超过 100 MB' }); return }
            chunks.push(Buffer.from(chunk))
          }
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if (route === '') {
            const input = body as QueueSubmission
            if (typeof input.baseUrl !== 'string') throw new Error('ComfyUI 地址无效')
            if (input.baseUrl === '/comfy') input.baseUrl = comfyUrl
            else if (input.baseUrl.startsWith('/')) throw new Error('不支持此 ComfyUI 地址，请填写完整地址或 /comfy')
            json(201, { id: await queue.enqueue(input) })
          } else if (route === '/action') {
            await queue.action(body.action, body.id)
            json(200, { ok: true })
          } else json(404, { error: '接口不存在' })
        } catch (error) {
          console.error('[local-queue]', error)
          json(400, { error: error instanceof Error ? error.message : '队列操作失败' })
        }
      }
      server.middlewares.use((req, res, next) => {
        if (!/^\/api\/local-queue(?:\/|\?|$)/.test(req.url || '')) return next()
        void handle(req, res)
      })
    },
  }
}
