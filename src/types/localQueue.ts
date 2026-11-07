import type { GenerationSnapshot } from './gallery.ts'

export type QueueStatus = 'queued' | 'submitting' | 'running' | 'completed' | 'failed' | 'uncertain'
export interface QueueJob {
  id: string
  createdAt: number
  startedAt?: number
  completedAt?: number
  summary: string
  prompt: string
  status: QueueStatus
  promptId?: string
  submissionId?: string
  message?: string
  progress?: number
  output?: string
}
export interface QueueState { paused: boolean; jobs: QueueJob[] }
export interface QueueSubmission {
  id: string
  baseUrl: string
  apiKey: string
  workflow: Record<string, unknown>
  summary: string
  prompt: string
  snapshot: GenerationSnapshot
}
