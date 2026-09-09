const $ = (id) => document.getElementById(id)
let selected = localStorage.getItem('conversation')
let signedIn = false, polling = false, sending = false
let current = null, rendered = '', listed = ''
const drafts = new Map()
let providers = [], settingsFor = null, settingsDirty = false, settingsSaving = false, renderedSelection = ''
let chatgpt = { connected: false }, connectionBusy = false, modelBusy = false
function renderConnection() {
  $('chatgpt-status').textContent = chatgpt.connected ? 'Connected ' + (chatgpt.account || '')
    : chatgpt.pending ? 'Waiting for OpenAI authorization…' : chatgpt.error || 'Not connected'
  $('chatgpt-code').textContent = chatgpt.pending?.code || ''
  $('chatgpt-device').hidden = !chatgpt.pending
  $('chatgpt-connect').hidden = chatgpt.connected || !!chatgpt.pending
  $('chatgpt-disconnect').hidden = !chatgpt.connected && !chatgpt.pending
  $('chatgpt-disconnect').textContent = chatgpt.pending ? 'Cancel login' : 'Disconnect'
  $('chatgpt-models').hidden = !chatgpt.connected
  $('chatgpt-connect').disabled = $('chatgpt-disconnect').disabled = connectionBusy
  $('chatgpt-models').disabled = modelBusy || connectionBusy
  for (const p of providers) if (p.connectable) p.unavailable = chatgpt.connected ? undefined : 'Connect ChatGPT'
}
async function loadModels() {
  if (modelBusy || !chatgpt.connected) return
  modelBusy = true; renderConnection()
  try {
    const config = await api('/chatgpt/models', 'POST', {})
    if (!signedIn) return
    providers = config.providers
    renderedSelection = ''
    if (!settingsDirty) renderSettings(true)
    else modelControls($('reasoning').value)
  } catch (e) { notice(e.message) }
  finally { modelBusy = false; renderConnection(); updateControls() }
}
async function refreshConnection() {
  const state = await api('/chatgpt')
  if (!signedIn) return
  const newlyConnected = state.connected && !chatgpt.connected
  const changed = state.connected !== chatgpt.connected
  chatgpt = state; renderConnection()
  if (changed) {
    renderedSelection = ''
    if (!settingsDirty) renderSettings(true)
    else modelControls($('reasoning').value)
    updateControls()
  }
  if (newlyConnected) void loadModels()
}
async function changeConnection(action) {
  if (connectionBusy) return
  if (action === 'disconnect' && chatgpt.connected && !confirm('Disconnect ChatGPT for all chats? Local credentials will be removed.')) return
  if (action === 'connect' && !confirm('Connect your ChatGPT account directly to this server? OpenAI’s login page may call this Codex; no Codex executable is used. Only approve the code shown here.')) return
  connectionBusy = true; renderConnection()
  try {
    const state = await api('/chatgpt/' + action, 'POST', {})
    if (!signedIn) return
    chatgpt = state; notice()
    providers = (await api('/providers')).providers
    renderedSelection = ''; renderConnection()
    if (!settingsDirty) renderSettings(true)
    else modelControls($('reasoning').value)
  } catch (e) { notice(e.message) }
  finally { connectionBusy = false; renderConnection(); updateControls() }
}
$('chatgpt-connect').onclick = () => void changeConnection('connect')
$('chatgpt-disconnect').onclick = () => void changeConnection('disconnect')
$('chatgpt-models').onclick = () => void loadModels()
function option(value, text = value) {
  const node = document.createElement('option')
  node.value = value; node.textContent = text
  return node
}
function modelControls(reasoning = 'default') {
  const p = providers.find((p) => p.id === $('provider').value)
  $('model-list').replaceChildren(...(p?.models || []).map((m) => option(m.id)))
  const model = p?.models.find((m) => m.id === $('model').value)
  const levels = model?.reasoning || []
  $('reasoning').replaceChildren(option('default', 'Provider default'), ...levels.map((v) => option(v)))
  $('reasoning').value = levels.includes(reasoning) ? reasoning : 'default'
  $('provider-note').textContent = [p?.unavailable, p?.note, !levels.length ? 'No configured reasoning control for this model.' : ''].filter(Boolean).join(' ')
}
function renderSettings(force = false) {
  if (!current) return
  if (!force && settingsFor === selected && (settingsDirty || renderedSelection === JSON.stringify(current.selection))) return
  settingsFor = selected; settingsDirty = false
  renderedSelection = JSON.stringify(current.selection)
  const selection = current.selection
  $('provider').replaceChildren(...providers.map((p) => {
    const node = option(p.id, p.label + (p.unavailable ? p.connectable ? ' — connect account' : ' — unavailable' : ''))
    node.disabled = !!p.unavailable && !p.connectable
    return node
  }))
  if (!providers.some((p) => p.id === selection.provider))
    $('provider').append(option(selection.provider, selection.provider + ' — missing configuration'))
  $('provider').value = selection.provider
  $('model').value = selection.model
  modelControls(selection.reasoning)
}
$('provider').onchange = () => {
  settingsDirty = true
  $('model').value = providers.find((p) => p.id === $('provider').value)?.models[0]?.id || ''
  modelControls(); updateControls()
}
$('model').oninput = () => { settingsDirty = true; modelControls(); updateControls() }
$('reasoning').onchange = () => { settingsDirty = true; updateControls() }
$('reset-settings').onclick = () => { renderSettings(true); updateControls(); notice() }
$('settings-form').onsubmit = async (event) => {
  event.preventDefault()
  if (!current || settingsSaving || ['queued', 'running'].includes(current.status)) return
  const id = selected
  settingsSaving = true; updateControls()
  try {
    const c = await api('/conversations/' + id, 'PATCH', { selection: {
      provider: $('provider').value, model: $('model').value.trim(), reasoning: $('reasoning').value,
    } })
    if (selected === id && current) {
      current.selection = c.selection
      renderSettings(true)
    }
    notice('Settings saved.'); await refresh()
  } catch (e) { notice(e.message) }
  finally { settingsSaving = false; updateControls() }
}
function notice(text = '') { $('notice').textContent = text }
async function api(path, method = 'GET', body) {
  const response = await fetch('/api' + path, {
    method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await response.json()
  if (response.status === 401) showLogin()
  if (!response.ok) { const error = new Error(data.error || 'Request failed'); error.status = response.status; throw error }
  return data
}
function showLogin() {
  signedIn = false
  chatgpt = { connected: false }; renderConnection()
  resetWorkEditor(); workState = null; $('work-items').replaceChildren(); $('work-count').textContent = ''
  $('login').hidden = false
  $('workspace').hidden = true
  // Don't leave authenticated transcript content in the DOM after logout.
  $('messages').replaceChildren()
  clearDiagnostics()
  $('conversations').replaceChildren()
  rendered = listed = ''
  current = null; settingsFor = null; settingsDirty = false
  $('provider').replaceChildren(); $('model').value = ''; $('reasoning').replaceChildren(); $('provider-note').textContent = ''
}
function select(id) {
  showWork(false)
  if (selected) drafts.set(selected, $('input').value)
  selected = id
  updateNavigation()
  localStorage.setItem('conversation', id)
  current = null
  clearDiagnostics()
  settingsFor = null; settingsDirty = false
  rendered = ''
  $('messages').replaceChildren()
  $('input').value = drafts.get(id) || ''
  updateControls()
  void refresh().catch((e) => notice(e.message))
}
function updateControls() {
  const busy = !current || ['queued', 'running'].includes(current.status) || sending || settingsSaving
  $('input').disabled = !current
  const unavailable = !!current && (!providers.some((p) => p.id === current.selection.provider) || !!providers.find((p) => p.id === current.selection.provider)?.unavailable)
  $('send').disabled = busy || settingsDirty || unavailable
  $('rename').disabled = !current
  $('retry').hidden = !current || !['error', 'interrupted'].includes(current.status)
  $('retry').disabled = busy || settingsDirty || unavailable
  for (const id of ['provider', 'model', 'reasoning', 'apply-settings', 'reset-settings']) $(id).disabled = busy
  if (!busy && $('reasoning').options.length <= 1) $('reasoning').disabled = true
}
async function refresh() {
  if (!signedIn || polling) return
  polling = true
  try {
    await refreshConnection()
    if (!$('work').hidden) await refreshWork()
    const list = await api('/conversations')
    if (!signedIn) return
    if (selected && !list.some((c) => c.id === selected)) {
      selected = null
      localStorage.removeItem("conversation")
      current = null
      clearDiagnostics()
      rendered = ""
      $("messages").replaceChildren()
      $("title").textContent = "Choose or create a conversation"
      $("status").textContent = ""
      updateControls()
    }
    if (!selected && list.length) {
      selected = list[0].id
      localStorage.setItem('conversation', selected)
    }
    const signature = JSON.stringify(list) + selected
    if (signature !== listed) {
      listed = signature
      $('conversations').replaceChildren(...list.map((c) => {
        const button = document.createElement('button')
        const text = document.createElement('span')
        text.textContent = c.title
        const status = document.createElement('small')
        status.textContent = c.status
        button.append(text, status)
        button.dataset.conversation = c.id
        button.onclick = () => select(c.id)
        return button
      }))
    }
    updateNavigation()
    if (!selected) return
    const id = selected
    const c = await api('/conversations/' + id)
    if (selected !== id || !signedIn) return
    current = c
    renderSettings()
    $('title').textContent = c.title
    renderStatus()
    renderDiagnostics()
    const next = JSON.stringify(c.messages)
    if (next !== rendered) {
      const box = $('messages')
      const bottom = box.scrollHeight - box.scrollTop - box.clientHeight < 100 || !rendered
      const opened = new Set([...box.querySelectorAll('details[open]')].map((d) => d.dataset.index))
      rendered = next
      box.replaceChildren(...c.messages.map((m, index) => {
        const tool = m.kind === 'command' || m.kind === 'result'
        const node = document.createElement(tool ? 'details' : 'article')
        node.className = tool ? '' : 'message ' + m.kind
        const label = document.createElement(tool ? 'summary' : 'div')
        label.className = 'label'
        label.textContent = ({ command: 'Tool call', result: 'Tool output', user: 'You', assistant: 'Successor' })[m.kind] || m.kind
        const text = document.createElement(tool ? 'pre' : 'div')
        text.className = 'text'
        // Intentionally plain text. Model/tool output is never executable HTML.
        text.textContent = m.text
        node.append(label, text)
        if (tool) { node.dataset.index = String(index); node.open = opened.has(String(index)) }
        return node
      }))
      if (bottom) box.scrollTop = box.scrollHeight
    }
    updateControls()
    if ($("notice").textContent.startsWith("Connection lost.")) notice()
  } finally { polling = false }
}
async function enter() {
  const config = await api('/providers')
  providers = config.providers
  signedIn = true
  $('login').hidden = true
  $('workspace').hidden = false
  notice()
  await refresh()
}
$('login-form').onsubmit = async (event) => {
  event.preventDefault()
  try {
    await api('/login', 'POST', { token: $('token').value.trim() })
    $('token').value = ''
    await enter()
  } catch (e) { notice(e.message) }
}
$('new').onclick = async () => {
  try { const c = await api('/conversations', 'POST', {}); select(c.id); notice() }
  catch (e) { notice(e.message) }
}
$('rename').onclick = async () => {
  if (!current) return
  const title = prompt('Conversation name', current.title)
  if (!title?.trim()) return
  try { await api('/conversations/' + selected, 'PATCH', { title }); await refresh() }
  catch (e) { notice(e.message) }
}
$('logout').onclick = async () => {
  try { await api('/logout', 'POST', {}); showLogin(); drafts.clear(); $('input').value = ''; notice() }
  catch (e) { notice(e.message) }
}
async function send(retry = false) {
  if (!current || sending || settingsSaving || settingsDirty || ['queued', 'running'].includes(current.status)) return
  const id = selected, text = $('input').value
  if (!retry && !text.trim()) return
  sending = true
  updateControls()
  try {
    await api('/conversations/' + id + '/turn', 'POST', retry ? { retry: true } : { input: text })
    if (!retry) {
      if (drafts.get(id) === text) drafts.delete(id)
      if (selected === id && $('input').value === text) $('input').value = ''
    }
    notice()
    await refresh()
  } catch (e) { notice(e.message + ' If the connection dropped, check saved history before resending.') }
  finally { sending = false; updateControls() }
}
$('compose').onsubmit = (event) => { event.preventDefault(); void send() }
$('retry').onclick = () => void send(true)
$('input').onkeydown = (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault(); void send()
  }
}

let workState = null, workSaving = false, editingWork = null, editRevision = null, workDraft = ''
function updateNavigation() {
  const open = !$('work').hidden
  $('open-work').setAttribute('aria-pressed', String(open))
  for (const button of $('conversations').children)
    button.setAttribute('aria-current', String(!open && button.dataset.conversation === selected))
}
function showWork(open) {
  $('work').hidden = !open; $('chat').hidden = open
  updateNavigation()
  if (open) void refreshWork().catch((e) => notice(e.message))
}
$('open-work').onclick = () => showWork(true)
$('close-work').onclick = () => showWork(false)
function resetWorkEditor() {
  editingWork = null; editRevision = null
  $('work-form').reset()
  $('work-form').hidden = true
  $('work-item-actions').replaceChildren()
  workDraft = workValues()
  $('work-editor-heading').textContent = 'Add work'
  $('work-save').textContent = 'Add item'
  $('work-cancel').hidden = true
}
function workValues() {
  return JSON.stringify(['work-title', 'work-description', 'work-notes'].map((id) => $(id).value))
}
function openWorkEditor(item = null) {
  if (workSaving) return
  if (!$('work-form').hidden && workValues() !== workDraft && !confirm('Discard the current unsaved draft?')) return
  resetWorkEditor()
  editingWork = item?.id || null; editRevision = workState?.revision
  if (item) {
    $('work-title').value = item.title; $('work-description').value = item.description; $('work-notes').value = item.notes
    $('work-editor-heading').textContent = 'Review / edit work'
    $('work-save').textContent = 'Save changes'
  }
  workDraft = workValues()
  $('work-form').hidden = false; $('work-cancel').hidden = false
  renderWork()
  $('work-title').focus(); $('work-form').scrollIntoView({ block: 'nearest' })
}
$('work-add').onclick = () => openWorkEditor()
$('work-cancel').onclick = () => {
  if (workValues() !== workDraft && !confirm('Discard the current unsaved draft?')) return
  resetWorkEditor(); renderWork()
  $('work-add').focus()
}
async function refreshWork() {
  if (!signedIn || workSaving) return
  const state = await api('/work-queue')
  if (!signedIn || workSaving || (workState && state.revision <= workState.revision)) return
  workState = state; renderWork()
}
function renderWork() {
  if (!workState) return
  const items = workState.items
  $('work-count').textContent = items.length ? (items.filter((i) => !i.done).length + ' remaining · ' + items.length + ' total') : 'Your queue is empty. Click Add work to create your first item.'
  $('work-add').disabled = workSaving
  $('work-item-actions').replaceChildren()
  $('work-items').replaceChildren(...items.map((item, index) => {
    const li = document.createElement('li')
    li.className = 'work-item' + (item.done ? ' done' : '')
    const title = document.createElement('button')
    title.type = 'button'; title.className = 'work-item-title'; title.disabled = workSaving
    title.textContent = (index + 1) + '. ' + item.title + (item.done ? ' — Done' : '')
    title.setAttribute('aria-controls', 'work-form')
    title.setAttribute('aria-expanded', String(editingWork === item.id))
    title.onclick = () => openWorkEditor(item)
    li.append(title)
    if (editingWork !== item.id) return li
    const actions = $('work-item-actions')
    const button = (label, callback, disabled = false) => {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = label
      b.disabled = workSaving || disabled; b.onclick = callback
      b.setAttribute('aria-label', label + ': ' + item.title); actions.append(b)
    }
    button('↑ Move up', () => void changeWork({ action: 'move', id: item.id, direction: 'up' }), index === 0)
    button('↓ Move down', () => void changeWork({ action: 'move', id: item.id, direction: 'down' }), index === items.length - 1)
    button(item.done ? 'Reopen' : 'Mark done', () => void changeWork({ action: 'update', id: item.id, item: { done: !item.done } }))
    button('Delete', () => { if (confirm('Delete “' + item.title + '” and its notes?')) void changeWork({ action: 'delete', id: item.id }) })
    return li
  }))
}
async function changeWork(command, fromEditor = false) {
  if (workSaving || !workState) return
  const revision = fromEditor && editingWork ? editRevision : workState.revision
  workSaving = true; $('work-fields').disabled = true; renderWork()
  try {
    const state = await api('/work-queue', 'POST', { revision, command })
    if (!signedIn) return
    workState = state
    if (editingWork && editRevision === revision) editRevision = state.revision
    if (fromEditor || (command.action === 'delete' && editingWork === command.id)) resetWorkEditor()
    notice('Queue saved.')
  } catch (e) {
    notice(e.message)
    if (e.status === 409 && signedIn) {
      // Keep the draft; require an explicit second save after reviewing fresh data.
      try { workState = await api('/work-queue'); editRevision = workState.revision }
      catch (error) { notice(error.message) }
    }
  } finally {
    workSaving = false; $('work-fields').disabled = false
    if (signedIn) renderWork()
  }
}
$('work-form').onsubmit = (event) => {
  event.preventDefault()
  const item = { title: $('work-title').value.trim(), description: $('work-description').value, notes: $('work-notes').value }
  if (!item.title) return
  void changeWork(editingWork ? { action: 'update', id: editingWork, item } : { action: 'add', item: { ...item, done: false } }, true)
}
setInterval(() => { void refresh().catch(() => notice('Connection lost. Reconnecting… Active turns continue on the server.')) }, 1500)
window.addEventListener('online', () => { notice(); void refresh().catch((e) => notice(e.message)) })
void enter().catch((e) => { if (e.message !== 'Sign in required') notice(e.message) })

// Status updates never modify composer or settings values.
function statusText(c, now = Date.now()) {
  const a = c.attempt
  if (!a) return 'Ready · ' + [c.selection.provider, c.selection.model, c.selection.reasoning].join(' / ')
  const elapsed = ['queued', 'running'].includes(a.status) ? Math.max(a.elapsedMs, now - Date.parse(a.timestamp)) : a.elapsedMs
  const timing = a.timingUnknown ? 'timing unknown' : Math.floor(Math.max(0, elapsed) / 1000) + 's elapsed'
  return [a.status, a.phase, timing, a.round ? 'round ' + a.round : '',
    'tools completed ' + a.toolsCompleted, a.checkpointItems === undefined ? '' : 'checkpoint: ' + a.checkpointItems + ' items',
    a.category ? a.category + ': ' + a.description : '',
    a.storageFailed ? 'Storage warning: diagnostics may only be in memory. Check disk space/permissions.' : '',
  ].filter(Boolean).join(' · ')
}
function renderStatus() {
  if (!current) return
  $('status').textContent = statusText(current)
  const a = current.attempt || current.selection
  $('status-selection').textContent = [a.provider, a.model, a.reasoning].join(' / ')
}
let diagnosticSignature = ''
function clearDiagnostics() {
  diagnosticSignature = ''
  $('status').textContent = ''; $('status-selection').textContent = ''
  $('diagnostic-summary').value = ''; $('diagnostic-list').replaceChildren()
  $('diagnostics').open = false
}
function renderDiagnostics() {
  const records = current?.diagnostics || []
  const signature = JSON.stringify(records)
  if (signature === diagnosticSignature) return
  diagnosticSignature = signature
  $('diagnostic-heading').textContent = 'Retained attempt details (' + records.length + ')'
  $('diagnostic-summary').value = JSON.stringify({ conversationId: current.id, attempts: records }, null, 2)
  $('diagnostic-list').replaceChildren(...records.slice().reverse().map((a) => {
    const row = document.createElement('p')
    row.textContent = a.timestamp + ' · ' + a.id + '\n' + statusText({ attempt: a }) + '\n' + [a.provider, a.model, a.reasoning].join(' / ')
    return row
  }))
}
$('copy-diagnostics').onclick = async () => {
  try {
    await navigator.clipboard.writeText($('diagnostic-summary').value)
    notice('Sanitized diagnostics copied. Review before sharing.')
  } catch {
    $('diagnostic-summary').focus(); $('diagnostic-summary').select()
    notice('Select and copy the sanitized summary below.')
  }
}
setInterval(() => { if (signedIn && current) renderStatus() }, 1000)
