import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'

// Small DOM double: exercise the shipped event handlers without browser dependencies.
function ui() {
  const nodes = new Map<string, any>()
  function element(tagName = 'div') {
    return {
      tagName,
      children: [] as any[], dataset: {} as Record<string, string>, attributes: {} as Record<string, string>,
      hidden: false, disabled: false, open: false, popoverOpen: false, value: '', textContent: '', innerHTML: '', className: '',
      showModal() { this.open = true }, close() { this.open = false },
      hidePopover() { this.popoverOpen = false },
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
    document: { getElementById: get, createElement: (tag: string) => element(tag) },
    localStorage: { getItem: () => 'chat-1', setItem() {} },
    fetch: () => new Promise(() => {}), setInterval() {},
    window: { addEventListener() {} }, confirm: () => false,
  })
  const markdown = readFileSync(new URL('./web/markdown.js', import.meta.url), 'utf8')
  runInContext(markdown, context)
  const source = readFileSync(new URL('./web/app.js', import.meta.url), 'utf8')
  const run = (code: string) => runInContext(code, context)
  run(source)
  const item = { id: 'task-1', title: 'First task', description: 'Detailed requirements', notes: 'Private notes', done: false, parentId: null, revision: 0 }
  run(`workState = ${JSON.stringify({ revision: 1, queueRevision: 0, queue: ['task-1', 'task-2'], items: [item, { ...item, id: 'task-2', title: 'Second task' }] })}; renderWork()`)
  return { get, run, element }
}

test('work queue navigation clears chat highlight immediately and restores it on return', () => {
  const { get, run, element } = ui()
  const chat = element(); chat.dataset.conversation = 'chat-1'
  get('conversations').append(chat)
  run('updateNavigation()')
  expect(chat.attributes['aria-current']).toBe('true')
  get('open-work-queue').onclick()
  expect(chat.attributes['aria-current']).toBe('false')
  expect(get('open-work-queue').attributes['aria-pressed']).toBe('true')
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
  expect(get('work-item-actions').children).toHaveLength(5)
  get('work-cancel').onclick()
  expect(get('work-form').hidden).toBe(true)
  get('work-add').onclick()
  expect(get('work-title').value).toBe('')
  expect(get('work-save').textContent).toBe('Add item')
})

test('passive renders and declined draft-discard prompts preserve unsaved notes', () => {
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

test('model dropdown shows alternatives and updates the editable model ID', () => {
  const { get, run } = ui()
  run("providers = [{ id: 'openai', models: [{ id: 'gpt-6-astra', label: 'Astra', reasoning: [], serviceTiers: [{ id: 'fast', name: 'Fast' }, { id: 'ultrafast', name: 'Ultrafast' }] }, { id: 'gpt-5-mini', reasoning: ['low'] }] }]; $('provider').value = 'openai'; $('model').value = 'gpt-6-astra'; modelControls()")
  expect(get('model-list').children.map((n: any) => n.value)).toEqual(['gpt-6-astra', 'gpt-5-mini'])
  expect(get('model-list').children[0].textContent).toBe('Astra (gpt-6-astra)')
  expect(get('service-tier').children.map((n: any) => n.value)).toEqual(['auto', 'standard', 'fast', 'ultrafast'])
  get('model-list').value = 'gpt-5-mini'
  get('model-list').onchange()
  expect(get('model').value).toBe('gpt-5-mini')
  expect(get('reasoning').children.map((n: any) => n.value)).toEqual(['default', 'low'])
  expect(get('model').value).toBe('gpt-5-mini')
})

test('reasoning is ordered strongest-first and unavailable discovered capabilities are disabled', () => {
  const { get, run } = ui()
  run("providers = [{ id: 'openai-chatgpt', supportsServiceTier: true, models: [{ id: 'gpt-6.1-sol', reasoning: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], unavailableReasoning: ['persistent'], serviceTiers: [{ id: 'priority', name: 'Fast' }, { id: 'ultrafast', name: 'Ultrafast', available: false, unavailableReason: 'Not enabled for this account' }] }] }]; $('provider').value = 'openai-chatgpt'; $('model').value = 'gpt-6.1-sol'; modelControls()")
  expect(get('reasoning').children.map((n: any) => n.textContent)).toEqual(['Default', 'Ultra', 'Max', 'XHigh', 'High', 'Medium', 'Low', 'Persistent — unavailable'])
  expect(get('reasoning').children.at(-1).disabled).toBe(true)
  expect(get('service-tier').children.map((n: any) => n.textContent)).toEqual(['Provider default', 'Standard', 'Fast', 'Ultrafast — unavailable'])
  expect(get('service-tier').children.at(-1).disabled).toBe(true)
})

test('plan view renders hierarchy collapsed by default and expands on demand', () => {
  const { get, run } = ui()
  run(`workState = { revision: 2, queueRevision: 0, queue: [], items: [
    { id: 'parent', title: 'Project', description: '', notes: '', done: false, parentId: null, revision: 0 },
    { id: 'child', title: 'Task', description: '', notes: '', done: false, parentId: 'parent', revision: 0 }
  ] }; setWorkView('structure')`)
  expect(get('work-tree').children).toHaveLength(1)
  const disclosure = get('work-tree').children[0].children[0]
  expect(disclosure.attributes['aria-expanded']).toBe('false')
  disclosure.onclick()
  expect(get('work-tree').children).toHaveLength(2)
  expect(get('work-tree').children[0].children[0].attributes['aria-expanded']).toBe('true')
})


test('chat settings are a popover and passive usage shares a footer with the drawer trigger', () => {
  const html = readFileSync(new URL('./web/index.html', import.meta.url), 'utf8')
  expect(html).toContain('popovertarget="settings"')
  expect(html).toContain('<section id="settings" popover')
  expect(html).toContain('<dialog id="diagnostics" aria-labelledby="diagnostic-heading">')
  const footer = html.slice(html.indexOf('<footer id="conversation-meta">'), html.indexOf('</footer>'))
  expect(html.indexOf('<footer')).toBeGreaterThan(html.indexOf('<form id="compose">'))
  expect(footer).toContain('<section id="usage"')
  expect(footer).toContain('id="open-diagnostics"')
  expect(footer).toContain('id="send" type="submit" form="compose"')
  const selection = html.slice(html.indexOf('<div class="model-selection">'), html.indexOf('<form id="compose">'))
  expect(selection).toContain('id="status-selection"')
  expect(selection).toContain('>change</button>')
  expect(selection).not.toContain('id="status"')
  expect(html.indexOf('id="status"')).toBeGreaterThan(html.indexOf('<dialog id="diagnostics"'))
  expect(footer).not.toContain('<details')
  expect(footer).not.toContain('<summary')
})

test('attempt drawer opens, closes, and clears on conversation changes', () => {
  const { get, run } = ui()
  get('open-diagnostics').onclick()
  expect(get('diagnostics').open).toBe(true)
  get('close-diagnostics').onclick()
  expect(get('diagnostics').open).toBe(false)
  run("current = { id: 'chat-1', diagnostics: [{ timestamp: '2026-01-01', id: 'attempt-1', status: 'done', elapsedMs: 1000 }] }; renderDiagnostics()")
  expect(get('open-diagnostics').textContent).toBe('Attempt details (1)')
  get('open-diagnostics').onclick()
  get('settings').popoverOpen = true
  run("select('chat-2')")
  expect(get('diagnostics').open).toBe(false)
  expect(get('settings').popoverOpen).toBe(false)
  expect(get('open-diagnostics').textContent).toBe('Attempt details (0)')
  expect(get('diagnostic-list').children).toHaveLength(0)
})

test('Enter submits; Shift+Enter and IME composition preserve native input behavior', () => {
  const { get } = ui()
  let submitted = 0, prevented = 0
  get('compose').requestSubmit = () => submitted++
  const key = (extra = {}) => get('input').onkeydown({ key: 'Enter', preventDefault() { prevented++ }, ...extra })
  key()
  expect(submitted).toBe(1)
  expect(prevented).toBe(1)
  key({ shiftKey: true })
  key({ isComposing: true })
  key({ keyCode: 229 })
  key({ key: 'a' })
  expect(submitted).toBe(1)
  expect(prevented).toBe(1)
  key({ repeat: true })
  get('send').disabled = true
  key()
  expect(submitted).toBe(1)
  expect(prevented).toBe(3)
})


test('usage renders compact input/output/cost while preserving accessible detail', () => {
  const { get, run } = ui()
  run("current = { usage: { reported: true, requests: 3, inputTokens: 91428, outputTokens: 4825, pricing: 'unavailable' } }; renderUsage()")
  expect(get('usage-data').textContent).toBe('91k/5k/$NA')
  expect(get('usage-data').attributes['aria-label']).toContain('91,428 input')
  run("current.usage.pricing = 'estimated'; current.usage.estimatedCostUsd = 0.1234; renderUsage()")
  expect(get('usage-data').textContent).toBe('91k/5k/$0.1234')
  run("current.usage.inputTokens = 999; current.usage.outputTokens = 0; current.usage.estimatedCostUsd = 0; renderUsage()")
  expect(get('usage-data').textContent).toBe('999/0/$0')
  run("current.usage.pricing = 'n/a (subscription)'; renderUsage()")
  expect(get('usage-data').textContent).toBe('999/0/$NA')
  expect(get('usage-data').attributes['aria-label']).toContain('subscription')
  run('clearDiagnostics()')
  expect(get('usage-data').textContent).toBe('0/0/$NA')
  expect(get('usage-data').attributes['aria-label']).toContain('No provider-reported')
})

test('composer shows the current selection rather than the previous attempt model', () => {
  const { get, run } = ui()
  run("current = { selection: { provider: 'openai', model: 'new-model', reasoning: 'high' }, attempt: { provider: 'openai', model: 'old-model', status: 'succeeded', phase: 'complete', elapsedMs: 89000, round: 10 } }; renderStatus()")
  expect(get('status-selection').textContent).toBe('openai / new-model / high')
  expect(get('status').textContent).toContain('succeeded · complete · 89s elapsed · round 10')
})

test('assistant Markdown supports GFM and extensions while raw HTML stays inert', () => {
  const { run } = ui()
  const html = run(`successorMarkdown.renderToHtml(${JSON.stringify(`***both*** and ~~gone~~ and \\*escaped\\*  \nnext\n\n<https://example.com>\n\n![alt](https://example.com/a.png)\n\n- parent\n  - child\n\n- [x] done\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nTerm\n: Definition\n\nfootnote[^1]\n\n[^1]: note\n\n$E=mc^2$\n\n> [!WARNING]\n> Careful\n\n<img src=x onerror=alert(1)>`)})`)
  expect(html).toContain('<em><strong>both</strong></em>')
  expect(html).toContain('<s>gone</s>')
  expect(html).toContain('*escaped*<br>')
  expect(html).toContain('target="_blank" rel="noopener noreferrer"')
  expect(html).toContain('<img src="https://example.com/a.png" alt="alt" loading="lazy" decoding="async">')
  expect(html).toContain('<p>parent</p>\n<ul>')
  expect(html).toContain('task-list-item-checkbox')
  expect(html).toContain('<table>')
  expect(html).toContain('<dl>')
  expect(html).toContain('footnote-ref')
  expect(html).toContain('class="katex"')
  expect(html).toContain('markdown-alert-warning')
  expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  expect(html).not.toContain('<img src="x"')
})

test('conversation sidebar uses icons only for working and failed states', () => {
  const { run } = ui()
  expect(run("conversationStatusIcon('idle')")).toBeNull()
  const running: any = run("conversationStatusIcon('running')")
  expect(running.className).toContain('working')
  expect(running.attributes['aria-label']).toBe('Working')
  expect(running.textContent).toBe('')
  const failed: any = run("conversationStatusIcon('error')")
  expect(failed.className).toContain('failed')
  expect(failed.attributes['aria-label']).toBe('Error')
})
