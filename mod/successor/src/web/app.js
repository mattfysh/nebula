const $ = (id) => document.getElementById(id)
function closeChatOverlays() {
  $('settings').hidePopover()
  if ($('diagnostics').open) $('diagnostics').close()
}
$('open-diagnostics').onclick = () => $('diagnostics').showModal()
$('close-diagnostics').onclick = () => $('diagnostics').close()
let selected = localStorage.getItem('conversation')
let signedIn = false, refreshing = false, refreshAgain = false, sending = false
let current = null, rendered = '', listed = ''
let responseStream = null, streamed = ''
const streamedByConversation = new Map()
let autoFollow = true, lastMessageScrollTop = 0
function atMessageBottom() {
  const box = $('messages')
  return box.scrollHeight - box.scrollTop - box.clientHeight <= 2
}
function scrollMessagesToBottom() {
  const box = $('messages')
  box.scrollTop = box.scrollHeight
  lastMessageScrollTop = box.scrollTop
}
// Any upward scroll means “I am reading”; only reaching the actual bottom resumes follow.
$('messages').onwheel = (event) => { if (event.deltaY < 0) autoFollow = false }
$('messages').ontouchstart = () => { autoFollow = false }
$('messages').onscroll = () => {
  const top = $('messages').scrollTop
  if (top < lastMessageScrollTop) autoFollow = false
  else if (atMessageBottom()) autoFollow = true
  lastMessageScrollTop = top
}
const drafts = new Map()
let providers = [], settingsFor = null, settingsDirty = false, settingsInvalid = false, settingsSaving = false, renderedSelection = ''
let chatgpt = { connected: false }, connectionBusy = false, modelBusy = false, connectionRefreshTimer = null

// Markdown is parsed by the bundled CommonMark/GFM renderer. It disables raw
// HTML and validates URLs before assigning this generated markup.
function renderMarkdown(parent, source) {
  successorMarkdown.render(parent, source)
}
function renderConnection() {
  $('chatgpt-status').textContent = chatgpt.connected ? 'Connected ' + (chatgpt.account || '')
    : chatgpt.pending ? 'Waiting for OpenAI authorization…' : chatgpt.error || 'Not connected'
  $('chatgpt-code').textContent = chatgpt.pending?.code || ''
  $('chatgpt-device').hidden = !chatgpt.pending
  $('chatgpt-connect').hidden = chatgpt.connected || !!chatgpt.pending
  $('chatgpt-disconnect').hidden = !chatgpt.connected && !chatgpt.pending
  $('chatgpt-disconnect').textContent = chatgpt.pending ? 'Cancel login' : 'Disconnect'
  $('chatgpt-connect').disabled = $('chatgpt-disconnect').disabled = connectionBusy
  for (const p of providers) if (p.connectable) p.unavailable = chatgpt.connected ? undefined : 'Connect ChatGPT'
}
async function loadModels(providerId = $('provider').value) {
  const provider = providers.find((p) => p.id === providerId)
  if (modelBusy || !provider?.modelDiscovery || provider.unavailable) return
  modelBusy = true; renderConnection()
  try {
    const config = await api('/providers/models', 'POST', { provider: provider.id })
    if (!signedIn) return
    providers = config.providers
    renderedSelection = ''
    if (!settingsDirty) renderSettings(true)
    else modelControls($('reasoning').value, $('service-tier').value)
  } catch (e) { notice(e.message) }
  finally { modelBusy = false; renderConnection(); updateControls() }
}
async function refreshConnection() {
  clearTimeout(connectionRefreshTimer); connectionRefreshTimer = null
  const state = await api('/chatgpt')
  if (!signedIn) return
  const newlyConnected = state.connected && !chatgpt.connected
  const changed = state.connected !== chatgpt.connected
  chatgpt = state; renderConnection()
  if (changed) {
    renderedSelection = ''
    if (!settingsDirty) renderSettings(true)
    else modelControls($('reasoning').value, $('service-tier').value)
    updateControls()
  }
  if (newlyConnected) void loadModels('openai-chatgpt')
  // Device authorization is the only state that needs polling; stop immediately
  // after it resolves instead of polling all application resources forever.
  if (state.pending) connectionRefreshTimer = setTimeout(() => void refreshConnection().catch((e) => notice(e.message)), 5000)
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
    if (state.pending) void refreshConnection()
    providers = (await api('/providers')).providers
    renderedSelection = ''; renderConnection()
    if (!settingsDirty) renderSettings(true)
    else modelControls($('reasoning').value, $('service-tier').value)
  } catch (e) { notice(e.message) }
  finally { connectionBusy = false; renderConnection(); updateControls() }
}
$('chatgpt-connect').onclick = () => void changeConnection('connect')
$('chatgpt-disconnect').onclick = () => void changeConnection('disconnect')
$('refresh-models').onclick = () => void loadModels()
function option(value, text = value) {
  const node = document.createElement('option')
  node.value = value; node.textContent = text
  return node
}
function modelControls(reasoning = 'default', serviceTier = 'auto') {
  const p = providers.find((p) => p.id === $('provider').value)
  const models = p?.models || []
  const currentModel = $('model').value
  $('model-list').replaceChildren(...models.map((m) => option(m.id, m.label ? `${m.label} (${m.id})` : m.id)),
    ...(!models.some((m) => m.id === currentModel) && currentModel ? [option(currentModel, currentModel + ' — unavailable')] : []))
  $('model-list').value = p?.models.some((m) => m.id === $('model').value) ? $('model').value : ''
  const model = p?.models.find((m) => m.id === $('model').value)
  const levels = model?.reasoning || []
  const unsupportedReasoning = reasoning !== 'default' && !levels.includes(reasoning)
  $('reasoning').replaceChildren(option('default', 'Default'), ...[...levels].reverse().map((v) => option(v, v === 'xhigh' ? 'XHigh' : v[0].toUpperCase() + v.slice(1))),
    ...(model?.unavailableReasoning || []).filter((v) => !levels.includes(v)).map((v) => { const node = option(v, (v === 'xhigh' ? 'XHigh' : v[0].toUpperCase() + v.slice(1)) + ' — unavailable'); node.disabled = true; return node }),
    ...(unsupportedReasoning ? [option(reasoning, reasoning + ' — unsupported')] : []))
  $('reasoning').value = unsupportedReasoning ? reasoning : levels.includes(reasoning) ? reasoning : 'default'
  const tiers = model?.serviceTiers || []
  const selectedTier = !serviceTier || serviceTier === 'default' ? 'auto' : serviceTier
  const unsupportedTier = !['auto', 'standard'].includes(selectedTier) && !tiers.some((tier) => tier.id === selectedTier)
  $('service-tier').replaceChildren(option('auto', 'Provider default'), option('standard', 'Standard'), ...tiers.map((tier) => { const node = option(tier.id, tier.name + (tier.available === false ? ' — unavailable' : '')); node.disabled = tier.available === false; if (tier.description) node.title = tier.description; return node }),
    ...(unsupportedTier ? [option(selectedTier, selectedTier + ' — unsupported')] : []))
  $('service-tier').value = selectedTier
  settingsInvalid = !model || unsupportedReasoning || unsupportedTier
  $('refresh-models').hidden = !p?.modelDiscovery
  $('refresh-models').disabled = modelBusy || !!p?.unavailable
  $('provider-note').textContent = [p?.unavailable, p?.note, settingsInvalid ? 'Saved capabilities are no longer supported; choose new settings.' : '', !levels.length ? 'No configured reasoning control for this model.' : ''].filter(Boolean).join(' ')
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
  modelControls(selection.reasoning, selection.serviceTier)
}
$('provider').onchange = () => {
  settingsDirty = true
  $('model').value = providers.find((p) => p.id === $('provider').value)?.models[0]?.id || ''
  modelControls(); updateControls()
}
$('model-list').onchange = () => {
  $('model').value = $('model-list').value
  $('model').oninput()
}
$('model').oninput = () => { settingsDirty = true; modelControls(); updateControls() }
$('reasoning').onchange = $('service-tier').onchange = () => { settingsDirty = true; updateControls() }
$('reset-settings').onclick = () => { renderSettings(true); updateControls(); notice() }
$('settings-form').onsubmit = async (event) => {
  event.preventDefault()
  if (!current || settingsSaving || ['queued', 'running'].includes(current.status)) return
  const id = selected
  settingsSaving = true; updateControls()
  try {
    const c = await api('/conversations/' + id, 'PATCH', {
      selection: {
        provider: $('provider').value, model: $('model').value.trim(), reasoning: $('reasoning').value, serviceTier: $('service-tier').value,
      }
    })
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
function renderStreamed() {
  const box = $('messages')
  let node = $('live-response')
  if (!streamed) { if (node) { node.hidden = true; node.children[1]?.replaceChildren() }; return }
  // Following is explicit state, not a fuzzy “near bottom” test: one upward
  // scroll disengages it until the reader returns to the actual bottom.
  if (!node) {
    node = document.createElement('article'); node.id = 'live-response'; node.className = 'message assistant streaming'
    const label = document.createElement('div'); label.className = 'label'; label.textContent = 'Successor'
    const text = document.createElement('div'); text.className = 'text'; node.append(label, text); box.append(node)
  }
  node.hidden = false
  const text = node.children[1]; text.replaceChildren(); renderMarkdown(text, streamed)
  if (autoFollow) scrollMessagesToBottom()
}
function openResponseStream() {
  const wanted = signedIn && typeof EventSource !== 'undefined'
  if (!wanted) {
    if (responseStream) responseStream.close()
    responseStream = null; streamed = ''; renderStreamed(); return
  }
  // Keep one connection while navigating between conversations.
  if (responseStream) {
    streamed = streamedByConversation.get(selected) || ''; renderStreamed(); return
  }
  const source = new EventSource('/api/events')
  responseStream = source
  source.addEventListener('snapshot', (event) => {
    streamedByConversation.clear()
    for (const [id, text] of Object.entries(JSON.parse(event.data).streams || {})) streamedByConversation.set(id, text)
    streamed = streamedByConversation.get(selected) || ''; renderStreamed()
    // Reconnection may have missed a completion while offline. Reconcile once.
    void refresh().catch((e) => notice(e.message))
  })
  source.addEventListener('delta', (event) => {
    const data = JSON.parse(event.data)
    const value = (streamedByConversation.get(data.id) || '') + (data.text || '')
    streamedByConversation.set(data.id, value)
    if (selected === data.id) { streamed = value; renderStreamed() }
  })
  source.addEventListener('reset', (event) => {
    const data = JSON.parse(event.data); streamedByConversation.delete(data.id)
    if (selected === data.id) streamed = ''
  })
  // Completion changes committed history and sidebar status. This replaces refreshing.
  source.addEventListener('refresh', () => { void refresh().catch((e) => notice(e.message)) })
}
function showLogin() {
  closeChatOverlays()
  if (responseStream) responseStream.close()
  responseStream = null
  streamedByConversation.clear(); streamed = ''
  signedIn = false
  clearTimeout(connectionRefreshTimer); connectionRefreshTimer = null
  chatgpt = { connected: false }; renderConnection()
  resetWorkEditor(); workState = null; $('work-items').replaceChildren(); $('work-count').textContent = ''
  $('login').hidden = false
  $('workspace').hidden = true
  // Don't leave authenticated transcript content in the DOM after logout.
  $('messages').replaceChildren()
  clearDiagnostics()
  $('conversations').replaceChildren()
  rendered = listed = ''
  current = null; settingsFor = null; settingsDirty = false; settingsInvalid = false
  $('provider').replaceChildren(); $('model').value = ''; $('reasoning').replaceChildren(); $('service-tier').replaceChildren(); $('provider-note').textContent = ''
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
  openResponseStream()
  $('input').value = drafts.get(id) || ''
  updateControls()
  void refresh().catch((e) => notice(e.message))
}
function updateControls() {
  const busy = !current || ['queued', 'running'].includes(current.status) || sending || settingsSaving
  $('input').disabled = !current
  const unavailable = !!current && (!providers.some((p) => p.id === current.selection.provider) || !!providers.find((p) => p.id === current.selection.provider)?.unavailable)
  $('send').disabled = busy || settingsDirty || settingsInvalid || unavailable
  $('rename').disabled = !current
  $('retry').hidden = !current || !['error', 'interrupted'].includes(current.status)
  $('retry').disabled = busy || settingsDirty || settingsInvalid || unavailable
  for (const id of ['provider', 'model-list', 'model', 'reasoning', 'service-tier', 'apply-settings', 'reset-settings', 'refresh-models']) $(id).disabled = busy
  if (!busy && $('reasoning').options.length <= 1) $('reasoning').disabled = true
  const provider = providers.find((p) => p.id === $('provider').value)
  if (!busy) $('refresh-models').disabled = modelBusy || !provider?.modelDiscovery || !!provider?.unavailable
  if (!busy && !provider?.supportsServiceTier) $('service-tier').disabled = true
}
function conversationStatusIcon(status) {
  if (!['queued', 'running', 'error', 'interrupted'].includes(status)) return null
  const icon = document.createElement('span')
  icon.className = 'conversation-status ' + (['queued', 'running'].includes(status) ? 'working' : 'failed')
  const label = ['queued', 'running'].includes(status) ? 'Working' : status === 'interrupted' ? 'Interrupted' : 'Error'
  icon.setAttribute('role', 'img')
  icon.setAttribute('aria-label', label)
  icon.title = label
  return icon
}
async function refresh() {
  if (!signedIn) return
  if (refreshing) { refreshAgain = true; return }
  refreshing = true
  try {
    if (!$('work').hidden) await refreshWork()
    const list = await api('/conversations')
    if (!signedIn) return
    if (selected && !list.some((c) => c.id === selected)) {
      selected = null
      localStorage.removeItem("conversation")
      current = null
      openResponseStream()
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
      openResponseStream()
    }
    const signature = JSON.stringify(list) + selected
    if (signature !== listed) {
      listed = signature
      $('conversations').replaceChildren(...list.map((c) => {
        const button = document.createElement('button')
        const text = document.createElement('span')
        text.textContent = c.title
        const status = conversationStatusIcon(c.status)
        button.append(text, ...(status ? [status] : []))
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
    renderUsage()
    renderDiagnostics()
    const next = JSON.stringify(c.messages)
    if (next !== rendered) {
      const box = $('messages')
      const follow = autoFollow || !rendered
      const previousTop = box.scrollTop
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
        // Tool output remains literal; assistant responses support safely rendered Markdown.
        if (m.kind === 'assistant') renderMarkdown(text, m.text)
        else text.textContent = m.text
        node.append(label, text)
        if (tool) { node.dataset.index = String(index); node.open = opened.has(String(index)) }
        return node
      }))
      renderStreamed()
      if (follow) scrollMessagesToBottom()
      else { box.scrollTop = previousTop; lastMessageScrollTop = box.scrollTop }
    }
    updateControls()
    if ($("notice").textContent.startsWith("Connection lost.")) notice()
  } finally {
    refreshing = false
    if (refreshAgain) { refreshAgain = false; queueMicrotask(() => void refresh().catch((e) => notice(e.message))) }
  }
}
async function enter() {
  const config = await api('/providers')
  providers = config.providers
  signedIn = true
  await refreshConnection()
  // Reconnect when restoring a conversation from localStorage on page load.
  // Previously streams only opened after manually selecting a conversation.
  openResponseStream()
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
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault()
    if (!event.repeat && !$('send').disabled) $('compose').requestSubmit()
  }
}

let workState = null, workSaving = false, editingWork = null, editRevision = null, workDraft = '', workView = 'queue'
const expandedWork = new Set()
function updateNavigation() {
  const open = !$('work').hidden
  $('open-work-queue').setAttribute('aria-pressed', String(open && workView === 'queue'))
  $('open-work-structure').setAttribute('aria-pressed', String(open && workView === 'structure'))
  for (const button of $('conversations').children) button.setAttribute('aria-current', String(!open && button.dataset.conversation === selected))
}
function showWork(open) { closeChatOverlays(); $('work').hidden = !open; $('chat').hidden = open; updateNavigation(); if (open) void refreshWork().catch((e) => notice(e.message)) }
$('open-work-queue').onclick = () => { setWorkView('queue'); showWork(true) }
$('open-work-structure').onclick = () => { setWorkView('structure'); showWork(true) }
$('close-work').onclick = () => showWork(false)
function setWorkView(view) {
  workView = view
  $('work-items').hidden = view !== 'queue'; $('work-tree').hidden = view !== 'structure'
  $('work-add').hidden = view !== 'structure'
  $('work-heading').textContent = view === 'queue' ? 'Focus queue' : 'Plan work'
  renderWork(); updateNavigation()
}
function resetWorkEditor() {
  editingWork = null; editRevision = null; $('work-form').reset()
  $('work-parent').replaceChildren(option('', 'Top level')); $('work-form').hidden = true
  $('work-item-actions').replaceChildren(); workDraft = workValues()
  $('work-editor-heading').textContent = 'Add work'; $('work-save').textContent = 'Add item'; $('work-cancel').hidden = true
}
function workValues() { return JSON.stringify(['work-title', 'work-description', 'work-parent', 'work-notes'].map((id) => $(id).value)) }
function descendants(id) {
  const found = new Set([id]); let changed = true
  while (changed) { changed = false; for (const x of workState?.items || []) if (x.parentId && found.has(x.parentId) && !found.has(x.id)) { found.add(x.id); changed = true } }
  return found
}
function openWorkEditor(item = null, parentId = null) {
  if (workSaving) return
  if (!$('work-form').hidden && workValues() !== workDraft && !confirm('Discard the current unsaved draft?')) return
  resetWorkEditor(); editingWork = item?.id || null; editRevision = item?.revision ?? workState?.revision
  const excluded = item ? descendants(item.id) : new Set()
  const parents = (workState?.items || []).filter((x) => !excluded.has(x.id))
  $('work-parent').replaceChildren(option('', 'Top level'), ...parents.map((x) => option(x.id, x.title)))
  if (item) {
    $('work-title').value = item.title; $('work-description').value = item.description; $('work-parent').value = item.parentId || ''; $('work-notes').value = item.notes
    $('work-editor-heading').textContent = 'Review / edit work'; $('work-save').textContent = 'Save changes'
  } else $('work-parent').value = parentId || ''
  workDraft = workValues(); $('work-form').hidden = false; $('work-cancel').hidden = false
  renderWork(); $('work-title').focus()
}
$('work-add').onclick = () => openWorkEditor()
$('work-cancel').onclick = () => { if (workValues() !== workDraft && !confirm('Discard the current unsaved draft?')) return; resetWorkEditor(); renderWork(); $('work-add').focus() }
async function refreshWork() {
  if (!signedIn || workSaving) return
  const state = await api('/work-queue')
  if (!signedIn || workSaving || (workState && state.revision <= workState.revision)) return
  workState = state; renderWork()
}
function actionButton(actions, label, callback, disabled = false) {
  const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.disabled = workSaving || disabled; b.onclick = callback; actions.append(b); return b
}
function renderWork() {
  if (!workState) return
  const byId = new Map(workState.items.map((x) => [x.id, x])), queued = workState.queue.map((id) => byId.get(id)).filter(Boolean)
  $('work-count').textContent = workView === 'queue' ? (queued.length ? queued.length + ' focused item' + (queued.length === 1 ? '' : 's') : 'Your focus queue is empty. Choose work from the structure.') : workState.items.length + ' work item' + (workState.items.length === 1 ? '' : 's')
  $('work-add').disabled = workSaving; $('work-item-actions').replaceChildren()
  $('work-items').replaceChildren(...queued.map((item, index) => {
    const li = document.createElement('li'); li.className = 'work-item'
    const title = document.createElement('button'); title.type = 'button'; title.className = 'work-item-title'; title.disabled = workSaving
    const ancestry = []; let parent = byId.get(item.parentId)
    while (parent) { ancestry.unshift(parent.title); parent = byId.get(parent.parentId) }
    title.textContent = (index + 1) + '. ' + item.title
    if (ancestry.length) { const path = document.createElement('small'); path.className = 'work-relation'; path.textContent = ancestry.join(' › '); title.append(path) }
    title.onclick = () => openWorkEditor(item); li.append(title)
    return li
  }))
  const active = editingWork && byId.get(editingWork)
  if (active) {
    const actions = $('work-item-actions'), position = workState.queue.indexOf(active.id)
    if (workView === 'queue' && position >= 0) {
      actionButton(actions, '↑ Move up', () => void changeWork({ action: 'moveQueue', id: active.id, direction: 'up', queueRevision: workState.queueRevision }), position === 0)
      actionButton(actions, '↓ Move down', () => void changeWork({ action: 'moveQueue', id: active.id, direction: 'down', queueRevision: workState.queueRevision }), position === workState.queue.length - 1)
    }
    if (!active.done) actionButton(actions, position >= 0 ? 'Remove from queue' : 'Add to queue', () => void changeWork({ action: position >= 0 ? 'dequeue' : 'enqueue', id: active.id, queueRevision: workState.queueRevision }))
    actionButton(actions, active.done ? 'Reopen' : 'Mark done', () => void changeWork({ action: 'update', id: active.id, itemRevision: active.revision, item: { done: !active.done } }))
    actionButton(actions, 'Delete', () => { if (confirm('Delete “' + active.title + '”? Its children will be moved up one level.')) void changeWork({ action: 'delete', id: active.id, itemRevision: active.revision }) })
  }
  const children = new Map(); for (const item of workState.items) { const key = item.parentId && byId.has(item.parentId) ? item.parentId : ''; if (!children.has(key)) children.set(key, []); children.get(key).push(item) }
  const branch = (item, depth) => {
    const descendants = children.get(item.id) || [], expanded = expandedWork.has(item.id)
    const row = document.createElement('div'); row.className = 'work-tree-row' + (item.done ? ' done' : ''); row.style = row.style || {}; row.style.paddingLeft = (depth * 1.2) + 'rem'
    if (descendants.length) {
      const disclosure = document.createElement('button'); disclosure.type = 'button'; disclosure.className = 'work-disclosure'
      disclosure.textContent = expanded ? '▾' : '▸'; disclosure.setAttribute('aria-expanded', String(expanded)); disclosure.setAttribute('aria-label', (expanded ? 'Collapse ' : 'Expand ') + item.title)
      disclosure.onclick = () => { expanded ? expandedWork.delete(item.id) : expandedWork.add(item.id); renderWork() }; row.append(disclosure)
    } else { const spacer = document.createElement('span'); spacer.className = 'work-disclosure-spacer'; row.append(spacer) }
    const title = document.createElement('button'); title.type = 'button'; title.className = 'work-tree-title'; title.textContent = item.title; title.onclick = () => openWorkEditor(item); row.append(title)
    const badge = document.createElement('small'), position = workState.queue.indexOf(item.id)
    badge.textContent = item.done ? 'Done' : position >= 0 ? 'Queue #' + (position + 1) : ''; row.append(badge)
    const controls = document.createElement('span'); controls.className = 'tree-actions'
    if (!item.done) actionButton(controls, position >= 0 ? 'Dequeue' : 'Queue', () => void changeWork({ action: position >= 0 ? 'dequeue' : 'enqueue', id: item.id, queueRevision: workState.queueRevision }))
    actionButton(controls, '+ Child', () => openWorkEditor(null, item.id)); row.append(controls)
    const nodes = [row]; if (expanded) for (const child of descendants) nodes.push(...branch(child, depth + 1)); return nodes
  }
  $('work-tree').replaceChildren(...(children.get('') || []).flatMap((x) => branch(x, 0)))
}
async function changeWork(command, fromEditor = false) {
  if (workSaving || !workState) return
  workSaving = true; $('work-fields').disabled = true; renderWork()
  try {
    const state = await api('/work-queue', 'POST', { command }); if (!signedIn) return
    workState = state; if (fromEditor || command.action === 'delete') resetWorkEditor(); notice('Work saved.')
  } catch (e) { notice(e.message); if (e.status === 409 && signedIn) try { workState = await api('/work-queue') } catch (error) { notice(error.message) } }
  finally { workSaving = false; $('work-fields').disabled = false; if (signedIn) renderWork() }
}
$('work-form').onsubmit = (event) => {
  event.preventDefault()
  const item = { title: $('work-title').value.trim(), description: $('work-description').value, parentId: $('work-parent').value || null, notes: $('work-notes').value }
  if (!item.title) return
  void changeWork(editingWork ? { action: 'update', id: editingWork, itemRevision: editRevision, item } : { action: 'add', revision: editRevision, item: { ...item, done: false } }, true)
}
window.addEventListener('online', () => { notice(); void refresh().catch((e) => notice(e.message)) })
void enter().catch((e) => { if (e.message !== 'Sign in required') notice(e.message) })

// Status updates never modify composer or settings values.
function statusText(c, now = Date.now()) {
  const a = c.attempt
  if (!a) return 'Ready · ' + [c.selection.provider, c.selection.model, c.selection.reasoning, ...(!c.selection.serviceTier || ['auto', 'default'].includes(c.selection.serviceTier) ? [] : [c.selection.serviceTier])].join(' / ')
  const elapsed = ['queued', 'running'].includes(a.status) ? Math.max(a.elapsedMs, now - Date.parse(a.timestamp)) : a.elapsedMs
  const timing = a.timingUnknown ? 'timing unknown' : Math.floor(Math.max(0, elapsed) / 1000) + 's elapsed'
  return [a.status, a.phase, timing, a.round ? 'round ' + a.round : '',
  'tools completed ' + a.toolsCompleted, a.checkpointItems === undefined ? '' : 'checkpoint: ' + a.checkpointItems + ' items',
  a.category ? a.category + ': ' + a.description : '',
  a.metadata?.providerDetail ? 'Provider: ' + a.metadata.providerDetail : '',
  a.storageFailed ? 'Storage warning: diagnostics may only be in memory. Check disk space/permissions.' : '',
  ].filter(Boolean).join(' · ')
}
function renderStatus() {
  if (!current) return
  $('status').textContent = statusText(current)
  const a = current.selection
  $('status-selection').textContent = [a.provider, a.model, a.reasoning, ...(!a.serviceTier || ['auto', 'default'].includes(a.serviceTier) ? [] : [a.serviceTier])].join(' / ')
}
function renderUsage() {
  const u = current?.usage
  if (!u) {
    $('usage-data').textContent = '0/0/$NA'
    $('usage-data').setAttribute('aria-label', 'No provider-reported token usage yet. Pricing estimate unavailable')
    return
  }
  const tokens = (n) => Number(n || 0).toLocaleString()
  const parts = [tokens(u.inputTokens) + ' input', tokens(u.outputTokens) + ' output']
  if (u.reasoningTokens) parts.push(tokens(u.reasoningTokens) + ' reasoning')
  if (u.cacheReadTokens) parts.push(tokens(u.cacheReadTokens) + ' cache read')
  if (u.cacheWriteTokens) parts.push(tokens(u.cacheWriteTokens) + ' cache write')
  const cost = u.pricing === 'estimated' ? 'Estimated cost: USD ' + u.estimatedCostUsd.toFixed(4) : u.pricing === 'n/a (subscription)' ? 'Pricing: N/A (subscription)' : 'Pricing estimate unavailable'
  $('usage-heading').textContent = 'Cumulative token usage (' + u.requests + ' provider response' + (u.requests === 1 ? '' : 's') + ')'
  const compactTokens = (n) => n >= 1000 ? Math.round(n / 1000) + 'k' : String(n || 0)
  const compactCost = u.pricing === 'estimated' ? u.estimatedCostUsd.toFixed(4).replace(/0+$/, '').replace(/\.$/, '') : 'NA'
  $('usage-data').textContent = compactTokens(u.inputTokens) + '/' + compactTokens(u.outputTokens) + '/\$' + compactCost
  $('usage-data').setAttribute('aria-label', u.reported ? 'Cumulative across ' + u.requests + ' provider responses · ' + parts.join(' · ') + ' · ' + cost : 'No provider-reported token usage yet. ' + cost)
}
let diagnosticSignature = ''
function clearDiagnostics() {
  diagnosticSignature = ''
  $('status').textContent = ''; $('status-selection').textContent = ''
  $('diagnostic-summary').value = ''; $('diagnostic-list').replaceChildren()
  $('usage-heading').textContent = 'Token usage'; $('usage-data').textContent = '0/0/$NA'
  $('usage-data').setAttribute('aria-label', 'No provider-reported token usage yet. Pricing estimate unavailable')
  $('diagnostic-heading').textContent = 'Retained attempt details (0)'
  $('open-diagnostics').textContent = 'Attempt details (0)'
  if ($('diagnostics').open) $('diagnostics').close()
}
function renderDiagnostics() {
  const records = current?.diagnostics || []
  const signature = JSON.stringify(records)
  if (signature === diagnosticSignature) return
  diagnosticSignature = signature
  $('diagnostic-heading').textContent = 'Retained attempt details (' + records.length + ')'
  $('open-diagnostics').textContent = 'Attempt details (' + records.length + ')'
  $('diagnostic-summary').value = JSON.stringify({ conversationId: current.id, attempts: records }, null, 2)
  $('diagnostic-list').replaceChildren(...records.slice().reverse().map((a) => {
    const row = document.createElement('p')
    row.textContent = a.timestamp + ' · ' + a.id + '\n' + statusText({ attempt: a }) + '\n' + [a.provider, a.model, a.reasoning, ...(!a.serviceTier || ['auto', 'default'].includes(a.serviceTier) ? [] : [a.serviceTier])].join(' / ')
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
