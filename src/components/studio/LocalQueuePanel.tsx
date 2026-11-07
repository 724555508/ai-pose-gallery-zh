import { useRef, useState } from 'react'
import { CheckIcon, ChevronRightIcon, CircleAlertIcon, Clock3Icon, CopyIcon, DownloadIcon, ImageIcon, LayersIcon, ListOrderedIcon, LoaderCircleIcon, PauseIcon, PlayIcon, RotateCcwIcon, Trash2Icon } from 'lucide-react'
import { useStudio } from '@/store/studioStore'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { ImageViewer } from '@/components/common/ImageViewer'
import { toast } from '@/lib/notifications'
import { cn } from '@/lib/utils'
import type { QueueJob, QueueStatus } from '@/types/localQueue'

const statuses: Record<QueueStatus, { label: string; color: string }> = {
  queued: { label: '等待中', color: 'bg-muted text-muted-foreground' },
  submitting: { label: '正在提交', color: 'bg-blue-500/10 text-blue-700 dark:text-blue-300' },
  running: { label: '执行中', color: 'bg-blue-500/10 text-blue-700 dark:text-blue-300' },
  completed: { label: '已完成', color: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' },
  failed: { label: '失败', color: 'bg-destructive/10 text-destructive' },
  uncertain: { label: '待核实', color: 'bg-amber-500/10 text-amber-700 dark:text-amber-300' },
}
const imageUrl = (id: string) => `/api/local-queue/${id}/image`
const time = (value: number) => new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
function elapsed(job: QueueJob) {
  if (!job.startedAt) return ''
  const seconds = Math.max(0, Math.floor(((job.completedAt || Date.now()) - job.startedAt) / 1000))
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
}
function Status({ status }: { status: QueueStatus }) {
  return <span className={cn('inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-1 text-[10px] font-medium leading-none', statuses[status].color)}>
    <span className={cn('size-1.5 rounded-full bg-current', (status === 'running' || status === 'submitting') && 'motion-safe:animate-pulse')} />{statuses[status].label}
  </span>
}

export function LocalQueuePanel() {
  const { localQueue, queueError, queueAction } = useStudio()
  const [busy, setBusy] = useState<string | null>(null)
  const actionLock = useRef(false)
  const [tab, setTab] = useState<'queued' | 'completed' | 'attention'>('queued')
  const [limit, setLimit] = useState(8)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [retryId, setRetryId] = useState<string | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const jobs = localQueue?.jobs || []
  const current = jobs.find((job) => ['submitting', 'running', 'uncertain'].includes(job.status))
  const waiting = jobs.filter((job) => job.status === 'queued')
  const completed = jobs.filter((job) => job.status === 'completed').reverse()
  const attention = jobs.filter((job) => job.status === 'failed' || job.status === 'uncertain').reverse()
  const list = tab === 'queued' ? waiting : tab === 'completed' ? completed : attention
  const selected = jobs.find((job) => job.id === selectedId)
  const paused = localQueue?.paused
  const action = async (name: string, id?: string) => {
    if (actionLock.current) return
    actionLock.current = true
    setBusy(`${name}:${id || ''}`)
    try {
      await queueAction(name, id)
      toast.success(name === 'pause' ? '队列已暂停，当前任务继续执行' : name === 'resume' ? '队列已继续' : name === 'remove' ? '已移除等待任务' : '任务已重新加入队列')
    } catch (e) { toast.error(e instanceof Error ? e.message : '队列操作失败') }
    finally { actionLock.current = false; setBusy(null) }
  }
  const operation = (job: QueueJob) => {
    const name = job.status === 'queued' ? 'remove' : job.status === 'uncertain' ? 'confirm-retry' : 'retry'
    if (job.status === 'completed') return <Button size="icon-sm" variant="ghost" className="size-9" asChild><a href={imageUrl(job.id)} download={job.output} aria-label={`下载 ${job.summary}`} title="下载原图"><DownloadIcon className="size-4" /></a></Button>
    if (!['queued', 'failed', 'uncertain'].includes(job.status)) return null
    return <Button size="icon-sm" variant="ghost" className={cn('size-9', job.status === 'queued' && 'text-muted-foreground hover:text-destructive')}
      aria-label={job.status === 'queued' ? `移除 ${job.summary}` : `重试 ${job.summary}`} title={job.status === 'queued' ? '移除等待任务' : '重试任务'} disabled={busy !== null}
      onClick={() => job.status === 'uncertain' ? setRetryId(job.id) : void action(name, job.id)}>
      {busy === `${name}:${job.id}` ? <LoaderCircleIcon className="size-4 animate-spin" /> : job.status === 'queued' ? <Trash2Icon className="size-3.5" /> : <RotateCcwIcon className="size-3.5" />}
    </Button>
  }

  return (
    <section aria-label="本地生成队列" className="min-w-0 overflow-hidden rounded-[22px] border border-border/70 bg-card shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 pt-5 sm:px-5">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-2xl bg-muted"><LayersIcon className="size-5" /></div>
          <div><h2 className="text-sm font-semibold">生成队列 <span className="ml-1 text-xs font-normal text-muted-foreground">ComfyUI</span></h2>
            <p className="mt-1 text-[11px] text-muted-foreground">{!localQueue ? '正在连接本地服务' : paused ? '派发已暂停' : current ? '正在处理你的创作' : waiting.length ? '准备开始下一项任务' : '准备好开始下一次创作'}</p>
          </div>
        </div>
        <Button variant="outline" size="sm" className="h-9 rounded-full px-3 text-xs shadow-none" disabled={busy !== null || !localQueue || !!queueError} onClick={() => void action(paused ? 'resume' : 'pause')}>
          {busy === 'pause:' || busy === 'resume:' ? <LoaderCircleIcon className="size-3.5 animate-spin" /> : paused ? <PlayIcon className="size-3.5" /> : <PauseIcon className="size-3.5" />}{paused ? '继续队列' : '暂停队列'}
        </Button>
      </div>
      {queueError && <div role="alert" className="mx-4 mt-4 flex items-start gap-2 rounded-xl bg-destructive/5 p-3 text-xs text-destructive sm:mx-5"><CircleAlertIcon className="mt-0.5 size-4 shrink-0" /><div><p className="font-medium">暂时无法同步队列</p><p className="mt-1 break-words leading-relaxed">{queueError}。后台任务可能仍在执行，请勿重复提交。</p></div></div>}
      {paused && !queueError && <p role="status" className="mx-4 mt-4 flex items-center gap-2 rounded-xl bg-amber-500/8 px-3 py-2.5 text-xs text-amber-800 dark:text-amber-300 sm:mx-5"><PauseIcon className="size-3.5 shrink-0" />{current ? '当前任务会继续完成，后续任务暂不派发。' : '等待任务已保留，点击继续即可恢复。'}</p>}

      {current && <div className={cn('mx-4 mt-4 rounded-2xl border p-4 sm:mx-5', current.status === 'uncertain' ? 'border-amber-500/20 bg-amber-500/5' : 'border-blue-500/15 bg-blue-500/4')}>
        <div className="mb-3 flex items-center justify-between gap-2"><span className="flex items-center gap-2 text-[11px] font-medium text-muted-foreground">{current.status === 'uncertain' ? <CircleAlertIcon className="size-3.5" /> : <LoaderCircleIcon className="size-3.5 motion-safe:animate-spin" />}{current.status === 'uncertain' ? '需要你的确认' : '当前任务'}</span><Status status={current.status} /></div>
        <button className="w-full cursor-pointer truncate text-left text-sm font-semibold outline-none focus-visible:underline" title={current.summary} onClick={() => setSelectedId(current.id)}>{current.summary}</button>
        <div className="mt-3 flex items-center justify-between gap-2 text-[11px] text-muted-foreground"><span className="min-w-0 truncate" title={current.message}>{current.message || '正在等待 ComfyUI 响应'}</span><span className="shrink-0 tabular-nums">已用时 {elapsed(current)}</span></div>
        {current.status !== 'uncertain' && <div role="progressbar" aria-label="当前节点进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={current.progress} className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-blue-500/10">
          <div className={cn('h-full rounded-full bg-blue-500 transition-[width] duration-500', current.progress === undefined && 'motion-safe:animate-pulse')} style={{ width: current.progress === undefined ? '28%' : `${Math.max(0, Math.min(100, current.progress))}%` }} />
        </div>}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2"><span className="text-[10px] text-muted-foreground">{current.status === 'uncertain' ? '确认提交结果前，后续任务会等待' : current.progress === undefined ? '正在等待节点进度' : `当前节点进度 · ${current.progress}%`}</span><Button size="xs" variant="ghost" onClick={() => setSelectedId(current.id)}>任务详情<ChevronRightIcon className="size-3" /></Button></div>
      </div>}

      <div className="mx-4 mt-5 grid grid-cols-3 gap-1 rounded-xl bg-muted/70 p-1 sm:mx-5" role="group" aria-label="筛选队列任务">
        {([{ key: 'queued', label: '等待', count: waiting.length }, { key: 'completed', label: '已完成', count: completed.length }, { key: 'attention', label: '需处理', count: attention.length }] as const).map((item) => <button key={item.key} type="button" aria-pressed={tab === item.key} onClick={() => { setTab(item.key); setLimit(8) }} className={cn('flex min-h-9 items-center justify-center gap-2 rounded-lg px-2 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-ring', tab === item.key ? 'bg-card font-medium text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
          {item.label}<span className={cn('rounded-md px-1.5 py-0.5 text-[10px] tabular-nums', item.key === 'attention' && item.count > 0 ? 'bg-destructive/10 text-destructive' : 'bg-foreground/5')}>{item.count}</span>
        </button>)}
      </div>
      <div className="px-4 pb-2 pt-2 sm:px-5" aria-busy={!localQueue && !queueError}>
        {!localQueue && !queueError ? <div className="space-y-4 py-4" aria-label="正在加载队列">{[0, 1].map((i) => <div key={i} className="flex items-center gap-3 motion-safe:animate-pulse"><div className="size-10 rounded-xl bg-muted" /><div className="flex-1 space-y-2"><div className="h-3 w-2/3 rounded bg-muted" /><div className="h-2 w-1/3 rounded bg-muted" /></div></div>)}</div>
          : list.length === 0 ? <div className="flex flex-col items-center px-3 py-8 text-center"><div className="mb-3 flex size-12 items-center justify-center rounded-2xl bg-muted/70 text-muted-foreground">{tab === 'completed' ? <ImageIcon className="size-5" /> : tab === 'attention' ? <CheckIcon className="size-5" /> : <ListOrderedIcon className="size-5" />}</div><p className="text-sm font-medium">{queueError && !localQueue ? '队列暂不可用' : tab === 'completed' ? '作品即将在这里出现' : tab === 'attention' ? '没有需要处理的任务' : current ? '没有更多等待任务' : '还没有等待任务'}</p><p className="mt-1.5 max-w-64 text-xs leading-relaxed text-muted-foreground">{queueError && !localQueue ? '连接恢复后会自动更新。' : tab === 'completed' ? '完成后可预览、下载，原图自动备份到 outputs。' : tab === 'attention' ? '失败或需要核实的任务会集中显示在这里。' : '选好配方后加入队列，无需等待上一张完成。'}</p></div>
            : <div className="max-h-[360px] divide-y divide-border/60 overflow-y-auto overscroll-contain">{list.slice(0, limit).map((job, index) => <div key={job.id} className="group flex min-w-0 items-center gap-3 py-3">
              {job.status === 'completed' ? <button type="button" className="size-11 shrink-0 overflow-hidden rounded-xl bg-muted ring-1 ring-border/50 transition hover:ring-foreground/30 focus-visible:outline-2 focus-visible:outline-ring" onClick={() => setPreview(imageUrl(job.id))} aria-label={`预览 ${job.summary}`}><img src={imageUrl(job.id)} alt={job.summary} loading="lazy" className="size-full object-cover transition-transform group-hover:scale-105" /></button>
                : <div className={cn('flex size-10 shrink-0 items-center justify-center rounded-xl text-xs font-medium tabular-nums', job.status === 'queued' ? 'bg-muted/70 text-muted-foreground' : 'bg-destructive/5 text-destructive')}>{job.status === 'queued' ? String(index + 1).padStart(2, '0') : <CircleAlertIcon className="size-4" />}</div>}
              <button type="button" className="min-w-0 flex-1 rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setSelectedId(job.id)} aria-label={`查看任务详情：${job.summary}`}>
                <p className="truncate text-xs font-medium" title={job.summary}>{job.summary}</p><div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground"><span title={new Date(job.createdAt).toLocaleString()}>{time(job.createdAt)}</span><span>·</span><span>{job.status === 'queued' ? paused ? '队列暂停中' : '等待自动执行' : job.status === 'completed' ? `用时 ${elapsed(job) || '—'}` : statuses[job.status].label}</span>{job.status === 'completed' && <CheckIcon className="size-3 text-emerald-600 dark:text-emerald-400" />}</div>
                {(job.status === 'failed' || job.status === 'uncertain') && <p className="mt-1 truncate text-[11px] text-destructive">{job.message}</p>}
              </button>
              <div className="flex shrink-0 items-center">{operation(job)}<Button size="icon-sm" variant="ghost" className="size-8 text-muted-foreground" aria-label={`展开 ${job.summary} 的详情`} onClick={() => setSelectedId(job.id)}><ChevronRightIcon className="size-3.5" /></Button></div>
            </div>)}</div>}
        {list.length > limit && <Button variant="ghost" className="my-1 w-full text-xs text-muted-foreground" onClick={() => setLimit((value) => value + 8)}>加载更多 · 还有 {list.length - limit} 条</Button>}
      </div>
      <div className="flex items-center gap-2 border-t border-border/60 bg-muted/25 px-4 py-3 text-[10px] text-muted-foreground sm:px-5"><Clock3Icon className="size-3 shrink-0" /><span>关闭网页后继续执行 · 请保持本地服务运行</span></div>

      <Dialog open={!!selected} onOpenChange={(open) => { if (!open) setSelectedId(null) }}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader><DialogTitle>任务详情</DialogTitle><DialogDescription>查看本次生成的提示词、状态和保存位置。</DialogDescription></DialogHeader>
          {selected && <div className="min-w-0 space-y-5">
            <div className="space-y-2"><Status status={selected.status} /><p className="break-words text-sm font-medium">{selected.summary}</p><p className="text-xs text-muted-foreground">{new Date(selected.createdAt).toLocaleString()}{selected.startedAt ? ` · 用时 ${elapsed(selected)}` : ''}</p></div>
            {selected.status === 'completed' && <button className="block w-full overflow-hidden rounded-xl bg-muted focus-visible:outline-2 focus-visible:outline-ring" aria-label="放大生成图片" onClick={() => setPreview(imageUrl(selected.id))}><img src={imageUrl(selected.id)} alt={selected.summary} className="mx-auto max-h-64 object-contain" /></button>}
            {selected.message && <p className={cn('rounded-xl bg-muted/70 p-3 text-xs leading-relaxed break-words', ['failed', 'uncertain'].includes(selected.status) && 'text-destructive')} role="status">{selected.message}</p>}
            <div><div className="mb-2 flex items-center justify-between"><h3 className="text-xs font-medium">本次提示词</h3><Button variant="ghost" size="xs" onClick={async () => { try { await navigator.clipboard.writeText(selected.prompt); toast.success('已复制提示词') } catch { toast.error('无法访问剪贴板，请手动复制') } }}><CopyIcon className="size-3" />复制</Button></div><p className="max-h-44 overflow-y-auto whitespace-pre-wrap break-words rounded-xl bg-muted/70 p-3 text-xs leading-relaxed">{selected.prompt}</p></div>
            <dl className="grid gap-3 text-xs"><div><dt className="mb-1 text-muted-foreground">任务编号</dt><dd className="break-all font-mono text-[11px] select-text">{selected.id}</dd></div>{selected.promptId && <div><dt className="mb-1 text-muted-foreground">ComfyUI 任务编号</dt><dd className="break-all font-mono text-[11px] select-text">{selected.promptId}</dd></div>}{selected.output && <div><dt className="mb-1 text-muted-foreground">备份位置</dt><dd className="break-all font-mono text-[11px] select-text">outputs/{selected.output}</dd></div>}</dl>
            <div className="flex justify-end gap-2">{selected.status === 'completed' ? <Button asChild><a href={imageUrl(selected.id)} download={selected.output}><DownloadIcon />下载原图</a></Button> : selected.status === 'failed' ? <Button disabled={busy !== null} onClick={() => void action('retry', selected.id)}><RotateCcwIcon />重新加入队列</Button> : selected.status === 'uncertain' ? <Button disabled={busy !== null} onClick={() => { setSelectedId(null); setRetryId(selected.id) }}>核实后重试</Button> : null}</div>
          </div>}
        </DialogContent>
      </Dialog>
      <AlertDialog open={!!retryId} onOpenChange={(open) => { if (!open) setRetryId(null) }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>确认这条任务没有提交？</AlertDialogTitle><AlertDialogDescription>请先在 ComfyUI 中核实：这条任务既未排队，也未执行或完成。重试会重新提交一次，未经核实可能重复生图。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>返回核实</AlertDialogCancel><AlertDialogAction disabled={busy !== null} onClick={() => { if (retryId) void action('confirm-retry', retryId); setRetryId(null) }}>已核实，重新提交</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
      <ImageViewer imageUrl={preview || ''} open={!!preview} onOpenChange={(open) => { if (!open) setPreview(null) }} />
    </section>
  )
}
