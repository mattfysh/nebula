import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'

// Small DOM double: exercise the shipped event handlers without browser dependencies.
function ui() {
  const nodes = new Map<string, any>()
  function element() {
    return {
      children: [] as any[], dataset: {} as Record<string, string>, attributes: {} as Record<string, string>,
      hidden: false, disabled: false, value: '', textContent: '',
      append(...children: any[]) { this.children.push(...children) },
      replaceChildren(...children: any[]) { this.children = children },
      setAttribute(key: string, value: string) { this.attributes[key] = value },
      focus() {}, scrollIntoView() {},
      reset() { for (const id of ['work-title', 'work-description', 'work-notes']) get(id).value = '' },
    }
  }
  function get(id: string) {
    if (!nodes.has(id)) nodes.set(id, element())
    return nodes.get(id)
  }
  get('work').hidden = get('work-form').hidden = true
  const context = createContext({
    document: { getElementById: get, createElement: element },
    localStorage: { getItem: () => 'chat-1', setItem() {} },
    fetch: () => new Promise(() => {}), setInterval() {},
    window: { addEventListener() {} }, confirm: () => false,
  })
  const source = readFileSync(new URL('./web/app.js', import.meta.url), 'utf8')
  const run = (code: string) => runInContext(code, context)
  run(source)
  const item = { id: 'task-1', title: 'First task', description: 'Detailed requirements', notes: 'Private notes', done: false }
  run(`workState = ${JSON.stringify({ revision: 1, items: [item, { ...item, id: 'task-2', title: 'Second task' }] })}; renderWork()`)
  return { get, run, element }
}

test('work queue navigation clears chat highlight immediately and restores it on return', () => {
  const { get, run, element } = ui()
  const chat = element(); chat.dataset.conversation = 'chat-1'
  get('conversations').append(chat)
  run('updateNavigation()')
  expect(chat.attributes['aria-current']).toBe('true')
  get('open-work').onclick()
  expect(chat.attributes['aria-current']).toBe('false')
  expect(get('open-work').attributes['aria-pressed']).toBe('true')
  run('updateNavigation()') // Polling must not restore the chat highlight.
  expect(chat.attributes['aria-current']).toBe('false')
  get('close-work').onclick()
  expect(chat.attributes['aria-current']).toBe('true')
})

test('queue rows contain only clickable titles; details and actions open in the editor', () => {
  const { get } = ui()
  expect(get('work-form').hidden).toBe(true)
  const rows = get('work-items').children
  expect(rows).toHaveLength(2)
  expect(rows[0].children).toHaveLength(1)
  expect(rows[0].children[0].textContent).toBe('1. First task')
  rows[0].children[0].onclick()
  expect(get('work-form').hidden).toBe(false)
  expect(get('work-description').value).toBe('Detailed requirements')
  expect(get('work-notes').value).toBe('Private notes')
  expect(get('work-item-actions').children).toHaveLength(4)
  get('work-cancel').onclick()
  expect(get('work-form').hidden).toBe(true)
  get('work-add').onclick()
  expect(get('work-title').value).toBe('')
  expect(get('work-save').textContent).toBe('Add item')
})

test('polling and declined draft-discard prompts preserve unsaved notes', () => {
  const { get, run } = ui()
  get('work-items').children[0].children[0].onclick()
  get('work-notes').value = 'Unsaved changes'
  run('renderWork()')
  get('work-items').children[1].children[0].onclick()
  expect(get('work-title').value).toBe('First task')
  get('work-cancel').onclick()
  expect(get('work-form').hidden).toBe(false)
  expect(get('work-notes').value).toBe('Unsaved changes')
})
