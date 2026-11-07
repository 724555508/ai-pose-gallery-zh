import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { QueueJob, QueueState, QueueSubmission } from '../src/types/localQueue.ts'

const active = (job: QueueJob) => ['submitting', 'running', 'uncertain'].includes(job.status)

export class ComfyQueue {
  state: QueueState = { paused: false, jobs: [] }
  private directory: string
  private writes: Promise<unknown> = Promise.resolve()
  private enqueues: Promise<unknown> = Promise.resolve()
  private stopped = false
  private busy = false
  private timer?: ReturnType<typeof setInterval>
  private socket?: WebSocket
  private owner = false
  private abort = new AbortController()
  private root: string
  private interval: number

  constructor(root: string, interval = 2000) {
    this.root = root
    this.interval = interval
    this.directory = path.join(root, '.local-queue')
  }

  async start() {
    await mkdir(this.directory, { recursive: true })
    const lock = path.join(this.directory, 'worker.lock')
    try {
      const pid = Number(await readFile(lock, 'utf8'))
      let alive = true
      try { process.kill(pid, 0) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false }
      if (alive) throw new Error('已有本地队列服务运行，请只启动一个 pnpm dev')
      await unlink(lock)
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    await writeFile(lock, String(process.pid), { flag: 'wx' })
    this.owner = true
    try {
      try {
        const saved = JSON.parse(await readFile(path.join(this.directory, 'state.json'), 'utf8'))
        if (!saved || !Array.isArray(saved.jobs) || typeof saved.paused !== 'boolean') throw new Error('队列文件格式无效')
        this.state = saved
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      for (const job of this.state.jobs) {
        if (job.status === 'submitting') {
          job.status = 'uncertain'
          job.message = '服务曾在提交期间中断，正在核实 ComfyUI 任务'
        }
      }
      await this.change(() => {})
      this.timer = setInterval(() => void this.tick(), this.interval)
      void this.tick()
    } catch (error) { await this.stop(); throw error }
  }

  async stop() {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.socket?.close()
    this.abort.abort()
    // Wait for the in-flight worker to finish before releasing ownership.
    while (this.busy) await new Promise((resolve) => setTimeout(resolve, 20))
    await this.enqueues.catch(() => {})
    await this.writes.catch(() => {})
    if (this.owner) {
      await unlink(path.join(this.directory, 'worker.lock')).catch(() => {})
      this.owner = false
    }
  }

  private change(update: () => void) {
    const operation = this.writes.catch(() => {}).then(async () => {
      const previous = structuredClone(this.state)
      try {
        update()
        const temporary = path.join(this.directory, 'state.tmp')
        await writeFile(temporary, JSON.stringify(this.state), { mode: 0o600 })
        await rename(temporary, path.join(this.directory, 'state.json'))
      } catch (error) { this.state = previous; throw error }
    })
    this.writes = operation
    return operation
  }

  private payloadPath(id: string) { return path.join(this.directory, `${id}.json`) }
  async payload(id: string): Promise<QueueSubmission> { return JSON.parse(await readFile(this.payloadPath(id), 'utf8')) }
  enqueue(input: QueueSubmission): Promise<string> {
    const operation = this.enqueues.catch(() => {}).then(() => this.enqueueOnce(input))
    this.enqueues = operation
    return operation
  }
  private async enqueueOnce(input: QueueSubmission) {
    if (!/^[\da-f-]{36}$/i.test(input.id) || !input.workflow || typeof input.workflow !== 'object'
      || Array.isArray(input.workflow) || !Object.keys(input.workflow).length || typeof input.prompt !== 'string'
      || typeof input.summary !== 'string' || typeof input.apiKey !== 'string' || !input.snapshot) throw new Error('无效队列任务')
    const url = new URL(input.baseUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('ComfyUI 地址无效')
    if (this.state.jobs.some((job) => job.id === input.id)) return input.id
    try { await writeFile(this.payloadPath(input.id), JSON.stringify(input), { flag: 'wx', mode: 0o600 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    await this.change(() => {
      if (this.state.jobs.some((job) => job.id === input.id)) return
      this.state.jobs.push({ id: input.id, createdAt: Date.now(), status: 'queued', summary: input.summary, prompt: input.prompt })
    })
    return input.id
  }

  async action(action: string, id?: string) {
    await this.change(() => {
      if (action === 'pause') { this.state.paused = true; return }
      if (action === 'resume') { this.state.paused = false; return }
      const job = this.state.jobs.find((item) => item.id === id)
      if (!job) throw new Error('任务不存在')
      if (action === 'remove' && job.status === 'queued') {
        this.state.jobs = this.state.jobs.filter((item) => item.id !== id)
      } else if (action === 'retry' && job.status === 'failed') {
        job.status = 'queued'; job.message = undefined; job.promptId = undefined
        job.startedAt = undefined; job.completedAt = undefined; job.progress = undefined
        this.state.jobs = [...this.state.jobs.filter((item) => item !== job), job]
      } else if (action === 'confirm-retry' && job.status === 'uncertain') {
        job.status = 'queued'; job.message = undefined; job.promptId = undefined
      } else throw new Error('当前状态不允许此操作')
    })
  }

  private async request(input: QueueSubmission, route: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers)
    if (input.apiKey.trim()) headers.set('Authorization', `Bearer ${input.apiKey.trim()}`)
    return fetch(`${input.baseUrl.replace(/\/+$/, '')}${route}`, {
      ...init, headers, signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(15000)]),
    })
  }
  private async json(input: QueueSubmission, route: string): Promise<any> {
    const response = await this.request(input, route)
    if (!response.ok) throw new Error(`ComfyUI 连接异常（${response.status}），稍后自动重连`)
    return response.json()
  }

  private subscribe(input: QueueSubmission, job: QueueJob) {
    if (this.socket || !job.promptId || this.stopped) return
    // Authenticated servers still have the HTTP fallback.
    if (input.apiKey.trim()) return
    const url = new URL(input.baseUrl)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.pathname = `${url.pathname.replace(/\/$/, '')}/ws`
    url.searchParams.set('clientId', job.submissionId || job.id)
    const socket = new WebSocket(url)
    this.socket = socket
    socket.onmessage = (event) => {
      if (typeof event.data !== 'string' || job.status !== 'running') return
      try {
        const message = JSON.parse(event.data)
        if (message.data?.prompt_id && message.data.prompt_id !== job.promptId) return
        if (message.type === 'progress' && message.data?.max > 0) {
          job.progress = Math.round(message.data.value / message.data.max * 100)
          job.message = `当前节点 ${job.progress}%`
        } else if (message.type === 'executing' && message.data?.node) {
          job.progress = undefined; job.message = `正在执行节点 ${message.data.node}`
        }
      } catch { /* Ignore binary previews and unrelated events. */ }
    }
    socket.onerror = () => { socket.onerror = null }
    socket.onclose = () => { if (this.socket === socket) this.socket = undefined }
  }

  private async reconcile(input: QueueSubmission, job: QueueJob) {
    const [queue, history] = await Promise.all([this.json(input, '/queue'), this.json(input, '/history?max_items=200')])
    const entries = [...(queue.queue_running || []), ...(queue.queue_pending || []), ...Object.values<any>(history).map((item) => item.prompt)]
    const match = entries.find((item) => item?.[3]?.local_queue_attempt === job.submissionId && job.submissionId)
    if (match?.[1]) {
      await this.change(() => { job.promptId = match[1]; job.status = 'running'; job.message = '已恢复任务跟踪' })
    } else job.message = '未找到提交结果。请在 ComfyUI 核实；确认未提交后才可重试'
  }

  private async poll(input: QueueSubmission, job: QueueJob) {
    this.subscribe(input, job)
    const history = await this.json(input, `/history/${encodeURIComponent(job.promptId!)}`)
    const result = history[job.promptId!]
    if (!result) {
      const queue = await this.json(input, '/queue')
      const position = (queue.queue_pending || []).findIndex((entry: any) => entry[1] === job.promptId)
      if (position >= 0) job.message = `ComfyUI 排队中，前方 ${position + (queue.queue_running?.length || 0)} 个任务`
      else if (!(queue.queue_running || []).some((entry: any) => entry[1] === job.promptId)) job.message = '等待 ComfyUI 确认结果；不会重复提交'
      return
    }
    if (result.status?.status_str === 'error' || result.status?.messages?.some((entry: any) => entry[0] === 'execution_error' || entry[0] === 'execution_interrupted')) {
      const error = result.status?.messages?.find((entry: any) => entry[0] === 'execution_error')?.[1]
      await this.change(() => { job.status = 'failed'; job.message = error?.exception_message || 'ComfyUI 执行失败或被中断'; job.completedAt = Date.now() })
      return
    }
    if (!result.status?.completed) return
    const images = Object.values<any>(result.outputs || {}).flatMap((node) => node.images || [])
    const image = images.find((item: any) => item.type === 'output') || images[0]
    if (!image?.filename) {
      await this.change(() => { job.status = 'failed'; job.message = '工作流完成但没有输出图片，请检查 SaveImage 节点'; job.completedAt = Date.now() })
      return
    }
    job.message = '正在保存图片到 outputs…'
    const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder || '', type: image.type || 'output' })
    const response = await this.request(input, `/view?${query}`)
    if (!response.ok) throw new Error('结果图片获取失败，稍后自动重试')
    const mime = response.headers.get('content-type')?.split(';')[0]
    const ext = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } as Record<string, string>)[mime || '']
    if (!ext) throw new Error('结果图片格式无效，等待重新获取')
    const bytes = Buffer.from(await response.arrayBuffer())
    if (!bytes.length) throw new Error('结果图片为空，等待重新获取')
    const output = `character-${job.id}.${ext}`
    await mkdir(path.join(this.root, 'outputs'), { recursive: true })
    const temporary = path.join(this.root, 'outputs', `${output}.part`)
    await writeFile(temporary, bytes)
    await rename(temporary, path.join(this.root, 'outputs', output))
    await this.change(() => { job.output = output; job.status = 'completed'; job.completedAt = Date.now(); job.progress = 100; job.message = '已保存到 outputs' })
  }

  private async tick() {
    if (this.busy || this.stopped) return
    this.busy = true
    let job: QueueJob | undefined
    try {
      job = this.state.jobs.find(active)
      if (!job) {
        this.socket?.close(); this.socket = undefined
        if (this.state.paused) return
        job = this.state.jobs.find((item) => item.status === 'queued')
        if (!job) return
        // A request may still be persisting its immutable payload.
        let input: QueueSubmission
        try { input = await this.payload(job.id) } catch { return }
        const selected = job
        await this.change(() => {
          if (this.state.paused || !this.state.jobs.includes(selected) || selected.status !== 'queued') return
          selected.status = 'submitting'; selected.startedAt = Date.now(); selected.submissionId = randomUUID(); selected.message = '正在提交工作流…'
        })
        if (job.status !== 'submitting') return
        let response: Response
        try {
          response = await this.request(input, '/prompt', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: input.workflow, client_id: job.submissionId, extra_data: { local_queue_id: job.id, local_queue_attempt: job.submissionId } }),
          })
        } catch { await this.change(() => { selected.status = 'uncertain'; selected.message = '提交结果待确认，已停止派发后续任务' }); return }
        const data: any = await response.json().catch(() => null)
        await this.change(() => {
          if (response.ok && typeof data?.prompt_id === 'string' && data.prompt_id) {
            selected.promptId = data.prompt_id; selected.status = 'running'; selected.message = '已提交，等待 ComfyUI 执行'
          } else if (response.status >= 400 && response.status < 500) {
            selected.status = 'failed'; selected.completedAt = Date.now(); selected.message = JSON.stringify(data?.error || data || `提交被拒绝（${response.status}）`)
          } else { selected.status = 'uncertain'; selected.message = '提交结果待确认，正在核实' }
        })
        return
      }
      const input = await this.payload(job.id)
      if (job.status === 'uncertain' || job.status === 'submitting') await this.reconcile(input, job)
      else await this.poll(input, job)
      if (!active(job)) { this.socket?.close(); this.socket = undefined }
    } catch (error) {
      if (job) job.message = error instanceof Error ? error.message : '队列服务异常，稍后重试'
      else console.error('[comfy-queue]', error)
    } finally { this.busy = false }
  }
}
