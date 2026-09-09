import { readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

const Fields = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(16_000),
  notes: z.string().max(16_000),
  done: z.boolean(),
}).strict()
const Item = Fields.extend({ id: z.string().uuid() })
const State = z.object({ revision: z.number().int().nonnegative(), items: z.array(Item).max(1000) })
const Command = z.discriminatedUnion('action', [
  z.object({ action: z.literal('add'), item: Fields }).strict(),
  z.object({ action: z.literal('update'), id: z.string().uuid(), item: Fields.partial() }).strict(),
  z.object({ action: z.literal('move'), id: z.string().uuid(), direction: z.enum(['up', 'down']) }).strict(),
  z.object({ action: z.literal('delete'), id: z.string().uuid() }).strict(),
])
const Request = z.object({ revision: z.number().int().nonnegative(), command: Command }).strict()

export async function workQueue(directory: string) {
  const path = join(directory, 'work-queue.json')
  let state: z.infer<typeof State> = { revision: 0, items: [] }
  try { state = State.parse(JSON.parse(await readFile(path, 'utf8'))) }
  catch (e: any) { if (e.code !== 'ENOENT') throw e }
  let writes = Promise.resolve()
  return {
    read: () => structuredClone(state),
    drained: () => writes,
    change: (body: unknown) => {
      const request = Request.parse(body)
      const result = writes.then(async () => {
        if (request.revision !== state.revision)
          return { status: 409, body: { error: 'Queue changed on another page. Review the latest queue and try again.' } }
        const next = structuredClone(state)
        const command = request.command
        if (command.action === 'add') {
          if (next.items.length >= 1000) return { status: 400, body: { error: 'Queue limit reached (1000 items).' } }
          next.items.push({ ...command.item, id: crypto.randomUUID() })
        } else {
          const index = next.items.findIndex((item) => item.id === command.id)
          const item = next.items[index]
          if (!item) return { status: 404, body: { error: 'Work item not found.' } }
          if (command.action === 'update') Object.assign(item, command.item)
          if (command.action === 'delete') next.items.splice(index, 1)
          if (command.action === 'move') {
            const target = index + (command.direction === 'up' ? -1 : 1)
            if (target >= 0 && target < next.items.length) {
              next.items.splice(index, 1)
              next.items.splice(target, 0, item)
            }
          }
        }
        next.revision++
        await writeFile(path + '.tmp', JSON.stringify(next) + '\n', { mode: 0o600 })
        await rename(path + '.tmp', path)
        state = next // Publish only after durable save; failed writes leave state unchanged.
        return { status: 200, body: structuredClone(state) }
      })
      writes = result.then(() => {}, () => {})
      return result
    },
  }
}
