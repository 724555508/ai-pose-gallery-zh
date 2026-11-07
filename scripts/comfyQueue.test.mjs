import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { ComfyQueue } from './comfyQueue.ts'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
async function waitFor(check) {
  const end = Date.now() + 8000
  while (Date.now() < end) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 15))
  }
  assert.fail('Timed out waiting for queue state')
}
async function harness(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'pose-queue-test-'))
  const submitted = []
  const records = new Map()
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const json = (data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)) }
    if (url.pathname === '/prompt') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const data = JSON.parse(Buffer.concat(chunks).toString())
      submitted.push(data)
      if (data.prompt.mode === 'reject') return json({ error: 'invalid workflow' }, 400)
      if (data.prompt.mode === 'unknown') { res.destroy(); return }
      const id = randomUUID()
      records.set(id, { prompt: [0, id, data.prompt, { ...data.extra_data, client_id: data.client_id }], complete: false, fail: false })
      if (data.prompt.mode === 'lost') { res.destroy(); return }
      json({ prompt_id: id }); return
    }
    if (url.pathname === '/queue') return json({ queue_running: [...records.values()].filter((r) => !r.complete).map((r) => r.prompt), queue_pending: [] })
    if (url.pathname === '/history') return json(Object.fromEntries(records))
    if (url.pathname.startsWith('/history/')) {
      const id = url.pathname.slice('/history/'.length)
      const record = records.get(id)
      return json(record?.complete ? { [id]: { prompt: record.prompt, status: { completed: true, status_str: record.fail ? 'error' : 'success', messages: record.fail ? [['execution_error', { exception_message: 'mock execution failed' }]] : [] }, outputs: { '9': { images: [{ filename: 'result.png', type: 'output' }] } } } } : {})
    }
    if (url.pathname === '/view') { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(png); return }
    res.writeHead(404); res.end()
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  let queue = new ComfyQueue(root, 20)
  await queue.start()
  const input = (mode = 'normal') => ({ id: randomUUID(), baseUrl, apiKey: '', summary: mode, prompt: `prompt ${mode}`, workflow: { mode }, snapshot: { recipe: {}, prompt: mode, settings: {}, models: {} } })
  const restart = async () => { await queue.stop(); queue = new ComfyQueue(root, 20); await queue.start(); return queue }
  try { await run({ get queue() { return queue }, root, submitted, records, input, restart }) }
  finally {
    await queue.stop()
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve))
    // Only remove the exact temporary tree created by this test.
    assert.ok(path.resolve(root).startsWith(path.join(path.resolve(tmpdir()), 'pose-queue-test-')))
    await rm(root, { recursive: true, force: true })
  }
}

test('FIFO dispatch, immutable payload, backend saves exact image, no browser required', async () => {
  await harness(async (h) => {
    const a = h.input(); const b = h.input()
    await h.queue.enqueue(a); await h.queue.enqueue(b)
    a.workflow.mode = 'changed later'
    await waitFor(() => h.submitted.length === 1)
    assert.equal(h.submitted[0].prompt.mode, 'normal')
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(h.submitted.length, 1)
    const first = [...h.records.values()][0]; first.complete = true
    await waitFor(() => h.submitted.length === 2)
    assert.equal(h.queue.state.jobs[0].status, 'completed')
    assert.deepEqual(await readFile(path.join(h.root, 'outputs', h.queue.state.jobs[0].output)), png)
    assert.equal(h.submitted[1].extra_data.local_queue_id, b.id)
    assert.notEqual(h.submitted[0].client_id, h.submitted[1].client_id)
    ;[...h.records.values()][1].complete = true
    await waitFor(() => h.queue.state.jobs.every((j) => j.status === 'completed'))
  })
})

test('pause persists across restart; waiting jobs can be removed and duplicate enqueue is idempotent', async () => {
  await harness(async (h) => {
    await h.queue.action('pause')
    const a = h.input(); const b = h.input()
    await Promise.all([h.queue.enqueue(a), h.queue.enqueue(a)])
    await h.queue.enqueue(b)
    assert.equal(h.queue.state.jobs.length, 2)
    await h.queue.action('remove', a.id)
    await h.restart()
    assert.equal(h.queue.state.paused, true)
    assert.equal(h.queue.state.jobs.length, 1)
    assert.equal(h.submitted.length, 0)
    await h.queue.action('resume')
    await waitFor(() => h.submitted.length === 1)
    await assert.rejects(() => h.queue.action('remove', b.id), /不允许/)
  })
})

test('running task is reconciled after restart without resubmitting; pause does not interrupt it', async () => {
  await harness(async (h) => {
    await h.queue.enqueue(h.input()); await h.queue.enqueue(h.input())
    await waitFor(() => h.queue.state.jobs[0].status === 'running')
    const id = h.queue.state.jobs[0].promptId
    await h.queue.action('pause')
    await h.restart()
    h.records.get(id).complete = true
    await waitFor(() => h.queue.state.jobs[0].status === 'completed')
    assert.equal(h.submitted.length, 1)
    assert.equal(h.queue.state.jobs[1].status, 'queued')
  })
})

test('lost submission response is found in ComfyUI queue and never submitted twice', async () => {
  await harness(async (h) => {
    await h.queue.enqueue(h.input('lost'))
    await waitFor(() => h.queue.state.jobs[0].status === 'running')
    assert.equal(h.submitted.length, 1)
    ;[...h.records.values()][0].complete = true
    await waitFor(() => h.queue.state.jobs[0].status === 'completed')
    assert.equal(h.submitted.length, 1)
  })
})

test('execution failure advances queue and retry uses a fresh submission identifier', async () => {
  await harness(async (h) => {
    const a = h.input(); await h.queue.enqueue(a); await h.queue.enqueue(h.input())
    await waitFor(() => h.queue.state.jobs[0].status === 'running')
    const first = [...h.records.values()][0]; first.fail = true; first.complete = true
    await waitFor(() => h.submitted.length === 2)
    assert.equal(h.queue.state.jobs[0].status, 'failed')
    await h.queue.action('retry', a.id)
    ;[...h.records.values()][1].complete = true
    await waitFor(() => h.submitted.length === 3)
    assert.equal(h.submitted[2].extra_data.local_queue_id, a.id)
    assert.notEqual(h.submitted[0].extra_data.local_queue_attempt, h.submitted[2].extra_data.local_queue_attempt)
  })
})

test('prompt validation rejection fails the job and starts the next one', async () => {
  await harness(async (h) => {
    await h.queue.enqueue(h.input('reject')); await h.queue.enqueue(h.input())
    await waitFor(() => h.submitted.length === 2)
    assert.equal(h.queue.state.jobs[0].status, 'failed')
    assert.match(h.queue.state.jobs[0].message, /invalid workflow/)
  })
})

test('exclusive worker ownership and corrupted state are not silently reset', async () => {
  await harness(async (h) => {
    const second = new ComfyQueue(h.root, 20)
    await assert.rejects(() => second.start(), /已有本地队列服务/)
    await h.queue.stop()
    await writeFile(path.join(h.root, '.local-queue', 'state.json'), '{broken')
    const corrupted = new ComfyQueue(h.root, 20)
    await assert.rejects(() => corrupted.start())
    await corrupted.stop()
  })
})

test('unresolved submission blocks later jobs across restart until explicit confirmation', async () => {
  await harness(async (h) => {
    const a = h.input('unknown')
    await h.queue.enqueue(a); await h.queue.enqueue(h.input())
    await waitFor(() => h.queue.state.jobs[0].status === 'uncertain')
    const previousAttempt = h.queue.state.jobs[0].submissionId
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(h.submitted.length, 1)
    await h.restart()
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(h.submitted.length, 1)
    assert.equal(h.queue.state.jobs[1].status, 'queued')
    await h.queue.action('confirm-retry', a.id)
    await waitFor(() => h.submitted.length === 2)
    assert.notEqual(h.queue.state.jobs[0].submissionId, previousAttempt)
  })
})

test('interruption at submitting state recovers by unique attempt, including historical completion', async () => {
  await harness(async (h) => {
    await h.queue.enqueue(h.input())
    await waitFor(() => h.queue.state.jobs[0].status === 'running')
    await h.queue.stop()
    const statePath = path.join(h.root, '.local-queue', 'state.json')
    const state = JSON.parse(await readFile(statePath, 'utf8'))
    state.jobs[0].status = 'submitting'; delete state.jobs[0].promptId
    await writeFile(statePath, JSON.stringify(state))
    ;[...h.records.values()][0].complete = true
    await h.restart()
    await waitFor(() => h.queue.state.jobs[0].status === 'completed')
    assert.equal(h.submitted.length, 1)
  })
})
