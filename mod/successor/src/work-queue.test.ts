import { expect, test } from 'bun:test'
import { mkdtemp, rm, stat, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { workQueue } from './work-queue.ts'

const item = (title: string) => ({ title, description: 'Acceptance criteria', notes: '<script>plain text</script>\nNext steps', done: false })

test('work queue supports descriptions, notes, ordering, completion, deletion, and restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'successor-work-'))
  try {
    const queue = await workQueue(directory)
    const change = (command: unknown) => queue.change({ revision: queue.read().revision, command })
    expect(queue.read()).toEqual({ revision: 0, items: [] })
    await change({ action: 'add', item: item('First') })
    await change({ action: 'add', item: item('Second') })
    const [a, b] = queue.read().items
    await change({ action: 'move', id: b!.id, direction: 'up' })
    expect(queue.read().items.map((i) => i.title)).toEqual(['Second', 'First'])
    await change({ action: 'move', id: b!.id, direction: 'up' }) // boundary is safe
    await change({ action: 'update', id: a!.id, item: { title: 'Revised', notes: 'New notes', done: true } })
    const restarted = await workQueue(directory)
    expect(restarted.read()).toEqual(queue.read())
    expect(restarted.read().items[1]).toEqual({ ...a!, title: 'Revised', notes: 'New notes', done: true })
    expect((await stat(join(directory, 'work-queue.json'))).mode & 0o777).toBe(0o600)
    await change({ action: 'update', id: a!.id, item: { done: false } })
    await change({ action: 'move', id: b!.id, direction: 'down' })
    expect(queue.read().items[0]!.done).toBe(false)
    await change({ action: 'delete', id: a!.id })
    expect(queue.read().items.map((i) => i.id)).toEqual([b!.id])
    expect((await change({ action: 'delete', id: a!.id })).status).toBe(404)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('concurrent/stale writes cannot overwrite each other; input is validated', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'successor-work-'))
  try {
    const queue = await workQueue(directory)
    const request = { revision: 0, command: { action: 'add', item: item('Task') } }
    const results = await Promise.all([queue.change(request), queue.change(request)])
    expect(results.map((r) => r.status)).toEqual([200, 409])
    expect(queue.read().items).toHaveLength(1)
    for (const invalid of [
      { ...request, revision: -1 },
      { revision: 1, command: { action: 'add', item: item('  ') } },
      { revision: 1, command: { action: 'add', item: { ...item('Task'), notes: 'x'.repeat(16001) } } },
      { revision: 1, command: { action: 'delete', id: '../../file' } },
      { revision: 1, command: { action: 'update', id: queue.read().items[0]!.id, item: { id: crypto.randomUUID() } } },
    ]) expect(() => queue.change(invalid)).toThrow()
    const snapshot = queue.read(); snapshot.items.length = 0
    expect(queue.read().items).toHaveLength(1)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('failed persistence leaves queue unchanged and later writes can succeed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'successor-work-'))
  try {
    const queue = await workQueue(directory)
    await mkdir(join(directory, 'work-queue.json.tmp'))
    const request = { revision: 0, command: { action: 'add', item: item('Task') } }
    await expect(queue.change(request)).rejects.toThrow()
    expect(queue.read()).toEqual({ revision: 0, items: [] })
    await rm(join(directory, 'work-queue.json.tmp'), { recursive: true })
    expect((await queue.change(request)).status).toBe(200)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
