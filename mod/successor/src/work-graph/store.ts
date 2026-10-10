import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { checkIntegrity, type Graph, type Node } from './model.ts'

const WorkData = z.object({
  title: z.string().trim().min(1).max(200), description: z.string().max(16_000),
  notes: z.string().max(16_000), done: z.boolean(), revision: z.number().int().nonnegative(),
  parentId: z.string().nullable().default(null), dependencies: z.array(z.string()).max(1000).default([]), links: z.array(z.string()).max(1000).default([]),
}).strict()
const StoredNode = z.object({ id: z.string(), plugin: z.string(), data: z.unknown(), content: z.array(z.string()) }).strict()
const Index = z.object({ version: z.literal(1), revision: z.number().int().nonnegative(), names: z.record(z.string(), z.string()) }).strict()
const ItemInput = WorkData.omit({ revision: true, parentId: true, dependencies: true, links: true })
const Command = z.discriminatedUnion('action', [
  z.object({ action: z.literal('add'), revision: z.number().int().nonnegative(), parentId: z.string().nullable(), item: ItemInput }).strict(),
  z.object({ action: z.literal('update'), id: z.string(), itemRevision: z.number().int().nonnegative(), parentId: z.string().nullable().optional(), dependencies: z.array(z.string()).max(1000).optional(), links: z.array(z.string()).max(1000).optional(), item: ItemInput.partial() }).strict(),
  z.object({ action: z.literal('delete'), id: z.string(), itemRevision: z.number().int().nonnegative() }).strict(),
  z.object({ action: z.literal('focus'), id: z.string(), focused: z.boolean(), revision: z.number().int().nonnegative() }).strict(),
  z.object({ action: z.literal('moveFocus'), id: z.string(), direction: z.enum(['up', 'down']), revision: z.number().int().nonnegative() }).strict(),
  z.object({ action: z.literal('active'), id: z.string().nullable(), revision: z.number().int().nonnegative() }).strict(),
])
const Request = z.object({ command: Command }).strict()
const FOCUS_ID = 'work-plan-focus'
const ACTIVE_ID = 'work-plan-active'

async function atomic(path: string, value: unknown) {
  await writeFile(path + '.tmp', JSON.stringify(value) + '\n', { mode: 0o600 })
  await rename(path + '.tmp', path)
}

/** Persistent adapter for the deliberately small work-graph model. */
export async function workGraph(directory: string) {
  const root = join(directory, 'work-graph'), nodesDir = join(root, 'nodes'), indexPath = join(root, 'index.json')
  await mkdir(nodesDir, { recursive: true, mode: 0o700 })
  let index: z.infer<typeof Index> | undefined
  const nodes = new Map<string, Node>()
  try { index = Index.parse(JSON.parse(await readFile(indexPath, 'utf8'))) }
  catch (error: any) { if (error.code !== 'ENOENT') throw error }
  if (index) for (const name of await readdir(nodesDir)) if (name.endsWith('.json')) {
    const node = StoredNode.parse(JSON.parse(await readFile(join(nodesDir, name), 'utf8')))
    if (encodeURIComponent(node.id) + '.json' !== name) throw new Error('Work graph node filename mismatch')
    nodes.set(node.id, node)
  }
  // Snapshot the old queue only when this graph is first created. The old UI/data remain available.
  if (!index) {
    const oldRoot = join(directory, 'work-queue'), oldItems = new Map<string, any>()
    try { for (const name of await readdir(join(oldRoot, 'items'))) if (name.endsWith('.json')) {
      const value = JSON.parse(await readFile(join(oldRoot, 'items', name), 'utf8')); oldItems.set(value.id, value)
    } } catch (error: any) { if (error.code !== 'ENOENT') throw error }
    let queue: string[] = []
    try { queue = JSON.parse(await readFile(join(oldRoot, 'index.json'), 'utf8')).queue ?? [] }
    catch (error: any) { if (error.code !== 'ENOENT') throw error }
    for (const value of oldItems.values()) nodes.set(value.id, {
      id: value.id, plugin: 'work-item',
      data: WorkData.parse({ title: value.title, description: value.description, notes: value.notes, done: value.done, revision: value.revision, parentId: value.parentId, dependencies: [], links: [] }),
      content: value.parentId && oldItems.has(value.parentId) ? [value.parentId] : [],
    })
    nodes.set(FOCUS_ID, { id: FOCUS_ID, plugin: 'work-focus', data: { title: 'Goals' }, content: queue.filter((id) => oldItems.has(id)) })
    nodes.set(ACTIVE_ID, { id: ACTIVE_ID, plugin: 'work-active', data: { title: 'Active' }, content: [] })
    index = { version: 1, revision: 0, names: { focus: FOCUS_ID } }
    for (const node of nodes.values()) await atomic(join(nodesDir, encodeURIComponent(node.id) + '.json'), node)
    await atomic(indexPath, index)
  }
  if (!nodes.has(FOCUS_ID)) nodes.set(FOCUS_ID, { id: FOCUS_ID, plugin: 'work-focus', data: { title: 'Goals' }, content: [] })
  if (!nodes.has(ACTIVE_ID)) { const active: Node = { id: ACTIVE_ID, plugin: 'work-active', data: { title: 'Active' }, content: [] }; nodes.set(ACTIVE_ID, active); await atomic(join(nodesDir, encodeURIComponent(ACTIVE_ID) + '.json'), active) }
  for (const node of nodes.values()) if (node.plugin === 'work-item' && (node.data as any).parentId === undefined) { node.data = WorkData.parse({ ...(node.data as any), parentId: node.content[0] ?? null, dependencies: [], links: [] }); await atomic(join(nodesDir, encodeURIComponent(node.id) + '.json'), node) }
  const graph = (): Graph => ({ nodes, names: new Map(Object.entries(index!.names)) })
  const item = (id: string) => { const node = nodes.get(id); return node?.plugin === 'work-item' ? node : undefined }
  const data = (node: Node) => WorkData.parse(node.data)
  const parent = (node: Node) => data(node).parentId
  const sync = (node: Node) => { const d = data(node); node.content = [...new Set([d.parentId, ...d.dependencies, ...d.links].filter((id): id is string => !!id))] }
  const snapshot = () => ({
    revision: index!.revision,
    names: Object.fromEntries(graph().names),
    focus: [...nodes.get(FOCUS_ID)!.content],
    active: nodes.get(ACTIVE_ID)!.content[0] ?? null,
    items: [...nodes.values()].filter((n) => n.plugin === 'work-item').map((n) => ({ id: n.id, ...data(n) })),
    issues: checkIntegrity(graph()),
  })
  let writes = Promise.resolve()
  const saveNode = (node: Node) => atomic(join(nodesDir, encodeURIComponent(node.id) + '.json'), node)
  return {
    read: snapshot, drained: () => writes,
    change(body: unknown) {
      const { command } = Request.parse(body)
      const result = writes.then(async () => {
        const fail = (status: number, error: string) => ({ status, body: { error } })
        if ('revision' in command && command.revision !== index!.revision) return fail(409, 'The plan changed on another page. Review it and try again.')
        const focus = nodes.get(FOCUS_ID)!
        const active = nodes.get(ACTIVE_ID)!
        if (command.action === 'add') {
          if (command.parentId && !item(command.parentId)) return fail(400, 'Parent work item not found.')
          if ([...nodes.values()].filter((n) => n.plugin === 'work-item').length >= 1000) return fail(400, 'Work item limit reached.')
          const node: Node = { id: crypto.randomUUID(), plugin: 'work-item', data: WorkData.parse({ ...command.item, revision: 0, parentId: command.parentId, dependencies: [], links: [] }), content: [] }; sync(node)
          await saveNode(node); nodes.set(node.id, node)
        } else if (command.action === 'active') {
          if (command.id && !item(command.id)) return fail(404, 'Work item not found.')
          active.content = command.id ? [command.id] : []; await saveNode(active)
        } else if (command.action === 'focus' || command.action === 'moveFocus') {
          if (!item(command.id)) return fail(404, 'Work item not found.')
          const at = focus.content.indexOf(command.id)
          if (command.action === 'focus') {
            if (command.focused && at < 0) focus.content.push(command.id)
            if (!command.focused && at >= 0) focus.content.splice(at, 1)
          } else if (at >= 0) {
            const target = at + (command.direction === 'up' ? -1 : 1)
            if (target >= 0 && target < focus.content.length) [focus.content[at], focus.content[target]] = [focus.content[target]!, focus.content[at]!]
          }
          await saveNode(focus)
        } else {
          const node = item(command.id)
          if (!node) return fail(404, 'Work item not found.')
          const current = WorkData.parse(node.data)
          if (current.revision !== command.itemRevision) return fail(409, 'This item changed on another page. Review it and try again.')
          if (command.action === 'update') {
            if (command.parentId === command.id) return fail(400, 'An item cannot contain itself.')
            if (command.parentId && !item(command.parentId)) return fail(400, 'Parent work item not found.')
            let ancestor = command.parentId
            while (ancestor) { if (ancestor === node.id) return fail(400, 'Work hierarchy cannot form a cycle.'); ancestor = parent(item(ancestor)!) }
            const oldLinks = new Set(current.links)
            const nextData = WorkData.parse({ ...current, ...command.item, revision: current.revision + 1, parentId: command.parentId === undefined ? current.parentId : command.parentId, dependencies: command.dependencies ?? current.dependencies, links: command.links ?? current.links })
            for (const id of [...nextData.dependencies, ...nextData.links]) if (id === node.id || !item(id)) return fail(400, 'Related work item not found or refers to itself.')
            node.data = nextData; sync(node)
            if (command.links) for (const otherId of new Set([...oldLinks, ...nextData.links])) { const other = item(otherId); if (!other) continue; const od = WorkData.parse(other.data), links = new Set(od.links); nextData.links.includes(otherId) ? links.add(node.id) : links.delete(node.id); other.data = { ...od, links: [...links], revision: od.revision + 1 }; sync(other); await saveNode(other) }
            if ((node.data as any).done) focus.content = focus.content.filter((id) => id !== node.id)
            await saveNode(node); await saveNode(focus)
          } else {
            for (const child of nodes.values()) if (child.plugin === 'work-item' && parent(child) === node.id) { const cd = WorkData.parse(child.data); child.data = { ...cd, parentId: current.parentId, revision: cd.revision + 1 }; sync(child); await saveNode(child) }
            for (const other of nodes.values()) if (other.plugin === 'work-item' && other.id !== node.id) { const od = WorkData.parse(other.data); const next = { ...od, parentId: od.parentId === node.id ? current.parentId : od.parentId, dependencies: od.dependencies.filter((id) => id !== node.id), links: od.links.filter((id) => id !== node.id) }; if (JSON.stringify(od) !== JSON.stringify(next)) { other.data = { ...next, revision: od.revision + 1 }; sync(other); await saveNode(other) } }
            nodes.delete(node.id); focus.content = focus.content.filter((id) => id !== node.id); active.content = active.content.filter((id) => id !== node.id); await saveNode(focus); await saveNode(active)
            await unlink(join(nodesDir, encodeURIComponent(node.id) + '.json')).catch(() => {})
          }
        }
        index!.revision++; await atomic(indexPath, index)
        return { status: 200, body: snapshot() }
      })
      writes = result.then(() => {}, () => {})
      return result
    },
  }
}
