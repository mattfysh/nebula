import { expect, test } from 'bun:test'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { workQueue } from './work-queue.ts'
const fields = (title: string, parentId: string | null = null) => ({ title, description: 'criteria', notes: 'notes', done: false, parentId })

test('work structure and focus queue are independent and persist as separate files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'work-'))
  try {
    const q = await workQueue(dir)
    await q.change({ command: { action: 'add', revision: 0, item: fields('Project') } })
    const parent = q.read().items[0]!
    await q.change({ command: { action: 'add', revision: 1, item: fields('Task', parent.id) } })
    const child = q.read().items[1]!
    expect(q.read().queue).toEqual([])
    await q.change({ command: { action: 'enqueue', id: child.id, queueRevision: 0 } })
    expect(q.read().queue).toEqual([child.id])
    expect((await stat(join(dir, 'work-queue', 'items', child.id + '.json'))).mode & 0o777).toBe(0o600)
    expect((await workQueue(dir)).read()).toEqual(q.read())
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('item revisions allow unrelated edits and reject conflicting edits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'work-'))
  try {
    const q = await workQueue(dir)
    await q.change({ command: { action: 'add', revision: 0, item: fields('A') } })
    await q.change({ command: { action: 'add', revision: 1, item: fields('B') } })
    const [a, b] = q.read().items
    expect((await q.change({ command: { action: 'update', id: a!.id, itemRevision: 0, item: { notes: 'a' } } })).status).toBe(200)
    expect((await q.change({ command: { action: 'update', id: b!.id, itemRevision: 0, item: { notes: 'b' } } })).status).toBe(200)
    expect((await q.change({ command: { action: 'update', id: a!.id, itemRevision: 0, item: { notes: 'stale' } } })).status).toBe(409)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('hierarchy rejects cycles; completion dequeues; deletion promotes children', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'work-'))
  try {
    const q = await workQueue(dir), add = async (title: string, parentId: string | null = null) => q.change({ command: { action: 'add', revision: q.read().revision, item: fields(title, parentId) } })
    await add('Parent'); const parent = q.read().items[0]!; await add('Child', parent.id); const child = q.read().items[1]!
    expect((await q.change({ command: { action: 'update', id: parent.id, itemRevision: 0, item: { parentId: child.id } } })).status).toBe(400)
    await q.change({ command: { action: 'enqueue', id: child.id, queueRevision: 0 } })
    await q.change({ command: { action: 'update', id: child.id, itemRevision: 0, item: { done: true } } })
    expect(q.read().queue).toEqual([])
    await q.change({ command: { action: 'delete', id: parent.id, itemRevision: 0 } })
    expect(q.read().items[0]!.parentId).toBeNull()
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('migrates the original monolithic queue and preserves active priority', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'work-'))
  try {
    const a = { ...fields('A'), id: crypto.randomUUID() }, b = { ...fields('B'), id: crypto.randomUUID(), done: true }
    await writeFile(join(dir, 'work-queue.json'), JSON.stringify({ revision: 7, items: [a, b] }))
    const state = (await workQueue(dir)).read()
    expect(state.items.map((x) => x.title)).toEqual(['A', 'B']); expect(state.queue).toEqual([a.id]); expect(state.revision).toBe(7)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
