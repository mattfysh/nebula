import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

const Fields = z.object({
  title: z.string().trim().min(1).max(200), description: z.string().max(16_000),
  notes: z.string().max(16_000), done: z.boolean(), parentId: z.string().uuid().nullable().default(null),
}).strict()
const Item = Fields.extend({ id: z.string().uuid(), revision: z.number().int().nonnegative() })
const Index = z.object({ revision: z.number().int().nonnegative(), queueRevision: z.number().int().nonnegative(), queue: z.array(z.string().uuid()).max(1000) }).strict()
const Command = z.discriminatedUnion('action', [
  z.object({ action: z.literal('add'), revision: z.number().int().nonnegative(), item: Fields }).strict(),
  z.object({ action: z.literal('update'), id: z.string().uuid(), itemRevision: z.number().int().nonnegative(), item: Fields.partial() }).strict(),
  z.object({ action: z.literal('delete'), id: z.string().uuid(), itemRevision: z.number().int().nonnegative() }).strict(),
  z.object({ action: z.literal('enqueue'), id: z.string().uuid(), queueRevision: z.number().int().nonnegative() }).strict(),
  z.object({ action: z.literal('dequeue'), id: z.string().uuid(), queueRevision: z.number().int().nonnegative() }).strict(),
  z.object({ action: z.literal('moveQueue'), id: z.string().uuid(), direction: z.enum(['up', 'down']), queueRevision: z.number().int().nonnegative() }).strict(),
])
const Request = z.object({ command: Command }).strict()
type WorkItem = z.infer<typeof Item>

async function atomic(path: string, value: unknown) {
  await writeFile(path + '.tmp', JSON.stringify(value) + '\n', { mode: 0o600 })
  await rename(path + '.tmp', path)
}

/** A small file per item avoids rewriting large notes and permits item-scoped optimistic edits. */
export async function workQueue(directory: string) {
  const root = join(directory, 'work-queue'), itemsDir = join(root, 'items'), indexPath = join(root, 'index.json')
  await mkdir(itemsDir, { recursive: true, mode: 0o700 })
  let index: z.infer<typeof Index> = { revision: 0, queueRevision: 0, queue: [] }
  const items = new Map<string, WorkItem>()
  try { index = Index.parse(JSON.parse(await readFile(indexPath, 'utf8'))) }
  catch (e: any) { if (e.code !== 'ENOENT') throw e }
  for (const name of await readdir(itemsDir)) if (/^[0-9a-f-]{36}\.json$/.test(name)) {
    const item = Item.parse(JSON.parse(await readFile(join(itemsDir, name), 'utf8')))
    items.set(item.id, item)
  }
  // One-time migration from the original monolithic, globally ordered queue.
  if (!items.size && index.revision === 0) try {
    const old = JSON.parse(await readFile(join(directory, 'work-queue.json'), 'utf8'))
    const migrated = z.array(Fields.extend({ id: z.string().uuid() })).parse(old.items?.map((x: any) => ({ parentId: null, ...x })))
    for (const value of migrated) {
      const item = { ...value, revision: 0 }; items.set(item.id, item); await atomic(join(itemsDir, item.id + '.json'), item)
    }
    index = { revision: old.revision || 0, queueRevision: 0, queue: migrated.filter((x) => !x.done).map((x) => x.id) }
    await atomic(indexPath, index)
  } catch (e: any) { if (e.code !== 'ENOENT') throw e }
  index.queue = index.queue.filter((id) => items.has(id))

  let writes = Promise.resolve()
  const snapshot = () => ({ ...index, queue: [...index.queue], items: [...items.values()].map((x) => structuredClone(x)) })
  const exists = (id: string | null) => !id || items.has(id)
  return {
    read: snapshot, drained: () => writes,
    change: (body: unknown) => {
      const { command } = Request.parse(body)
      const result = writes.then(async () => {
        const fail = (status: number, error: string) => ({ status, body: { error } })
        if (command.action === 'add') {
          if (command.revision !== index.revision) return fail(409, 'Work structure changed. Review it and try again.')
          if (!exists(command.item.parentId)) return fail(400, 'Parent work item not found.')
          if (items.size >= 1000) return fail(400, 'Work item limit reached (1000 items).')
          const item: WorkItem = { ...command.item, id: crypto.randomUUID(), revision: 0 }
          await atomic(join(itemsDir, item.id + '.json'), item)
          items.set(item.id, item); index.revision++; await atomic(indexPath, index)
          return { status: 200, body: snapshot() }
        }
        if (command.action === 'enqueue' || command.action === 'dequeue' || command.action === 'moveQueue') {
          if (command.queueRevision !== index.queueRevision) return fail(409, 'Queue priority changed. Review it and try again.')
          if (!items.has(command.id)) return fail(404, 'Work item not found.')
          const at = index.queue.indexOf(command.id)
          if (command.action === 'enqueue' && at < 0) index.queue.push(command.id)
          if (command.action === 'dequeue' && at >= 0) index.queue.splice(at, 1)
          if (command.action === 'moveQueue' && at >= 0) {
            const target = at + (command.direction === 'up' ? -1 : 1)
            if (target >= 0 && target < index.queue.length) [index.queue[at], index.queue[target]] = [index.queue[target]!, index.queue[at]!]
          }
          index.queueRevision++; index.revision++; await atomic(indexPath, index)
          return { status: 200, body: snapshot() }
        }
        const item = items.get(command.id)
        if (!item) return fail(404, 'Work item not found.')
        if (command.itemRevision !== item.revision) return fail(409, 'This work item changed on another page. Review it and try again.')
        if (command.action === 'update') {
          const parentId = command.item.parentId
          if (parentId === command.id) return fail(400, 'A work item cannot contain itself.')
          if (parentId && !items.has(parentId)) return fail(400, 'Parent work item not found.')
          let ancestor = parentId
          while (ancestor) {
            if (ancestor === command.id) return fail(400, 'Work item hierarchy cannot form a cycle.')
            ancestor = items.get(ancestor)?.parentId || null
          }
          const next = { ...item, ...command.item, revision: item.revision + 1 }
          await atomic(join(itemsDir, item.id + '.json'), next); items.set(item.id, next)
          if (next.done && index.queue.includes(next.id)) { index.queue = index.queue.filter((id) => id !== next.id); index.queueRevision++ }
        } else {
          // Preserve descendants by promoting them to the deleted item's parent.
          for (const child of items.values()) if (child.parentId === item.id) {
            const next = { ...child, parentId: item.parentId, revision: child.revision + 1 }
            await atomic(join(itemsDir, child.id + '.json'), next); items.set(child.id, next)
          }
          items.delete(item.id); index.queue = index.queue.filter((id) => id !== item.id); index.queueRevision++
        }
        index.revision++; await atomic(indexPath, index)
        if (command.action === 'delete') await unlink(join(itemsDir, item.id + '.json')).catch(() => {})
        return { status: 200, body: snapshot() }
      })
      writes = result.then(() => {}, () => {})
      return result
    },
  }
}
