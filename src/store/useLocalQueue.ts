import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { idbRead, idbWrite } from '@/lib/idbStorage'
import type { GenerationHistoryItem, GenerationSnapshot } from '@/types/gallery'
import type { QueueState, QueueSubmission } from '@/types/localQueue'
import { durableImage } from '@/lib/persistentImages'

const API = '/api/local-queue'
export const localQueueEnabled = Boolean(import.meta.env.VITE_LOCAL_IMAGE_BACKUP)
async function request(route: string, body?: unknown) {
  const response = await fetch(`${API}${route}`, {
    ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) {
    const data = await response.json().catch(() => null)
    throw new Error(data?.error || `本地队列请求失败（${response.status}）`)
  }
  return response.json()
}

export function useLocalQueue(onCompleted: (item: GenerationHistoryItem) => Promise<void>, ready: boolean) {
  const [queue, setQueue] = useState<QueueState | null>(null)
  const [error, setError] = useState('')
  const imports = useRef(new Set<string>())
  const completed = useEffectEvent(onCompleted)
  useEffect(() => {
    if (!localQueueEnabled || !ready) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const state: QueueState = await request('')
        if (stopped) return
        setQueue(state); setError('')
        for (const job of state.jobs) {
          if (stopped) return
          if (job.status !== 'completed' || imports.current.has(job.id)) continue
          const data: { snapshot: GenerationSnapshot } = await request(`/${job.id}`)
          const imageUrl = await durableImage(`${API}/${job.id}/image`)
          if (stopped) return
          await completed({ id: `local-queue:${job.id}`, createdAt: job.completedAt || job.createdAt, imageUrl,
            provider: 'comfyui', model: 'ComfyUI 工作流', prompt: job.prompt, recipeSummary: job.summary, snapshot: data.snapshot })
          imports.current.add(job.id)
          await idbWrite('pose_atlas_queue_imported', [...imports.current])
        }
      } catch (e) {
        if (!stopped) setError(e instanceof Error ? e.message : '本地队列连接失败')
      } finally { if (!stopped) timer = setTimeout(() => void poll(), 2000) }
    }
    void idbRead<string[]>('pose_atlas_queue_imported').then((saved) => {
      if (stopped) return
      imports.current = new Set(saved || [])
      void poll()
    }).catch((e) => { if (!stopped) setError(String(e)) })
    return () => { stopped = true; clearTimeout(timer) }
  }, [ready])
  const enqueue = async (submission: QueueSubmission) => request('', submission)
  const action = async (action: string, id?: string) => {
    await request('/action', { action, id })
    setQueue(await request(''))
  }
  return { queue, error, enqueue, action }
}
