const $ = (id) => document.getElementById(id)
let state, view = 'map', selected = null, editing = null, busy = false
const notice = (text = '') => { $('notice').textContent = text; if (text) setTimeout(() => { if ($('notice').textContent === text) $('notice').textContent = '' }, 3500) }
async function api(path, method = 'GET', body) {
  const response = await fetch('/api' + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
  const data = await response.json(); if (!response.ok) { const e = new Error(data.error || 'Request failed'); e.status = response.status; throw e } return data
}
function byId() { return new Map(state.items.map((x) => [x.id, x])) }
function descendants(id) { const found = new Set([id]); let changed = true; while (changed) { changed = false; for (const x of state.items) if (found.has(x.parentId) && !found.has(x.id)) { found.add(x.id); changed = true } } return found }
function stat(value, label) { const d = document.createElement('div'); d.className = 'stat'; const strong = document.createElement('strong'), span = document.createElement('span'); strong.textContent = value; span.textContent = label; d.append(strong, span); return d }
function button(label, cls, fn) { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.className = cls; b.onclick = fn; return b }
function render() {
  if (!state) return
  const items = state.items, map = byId(), focused = new Set(state.focus), query = $('search').value.trim().toLowerCase()
  $('stats').replaceChildren(stat(items.filter((x) => !x.done).length, 'Open items'), stat(state.focus.length, 'In focus'), stat(items.filter((x) => x.done).length, 'Completed'))
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-pressed', String(b.dataset.view === view))
  const visible = (x) => (!query || [x.title, x.description, x.notes].join(' ').toLowerCase().includes(query)) && (view === 'done' ? x.done : view === 'focus' ? focused.has(x.id) && !x.done : !x.done)
  if (view === 'alignment') { renderAlignment(map, focused); return }
  const children = new Map(); for (const x of items) { const key = map.has(x.parentId) ? x.parentId : ''; if (!children.has(key)) children.set(key, []); children.get(key).push(x) }
  const row = (item, depth, outcome = false) => {
    const r = document.createElement('div'); r.className = 'row' + (item.done ? ' done' : '') + (item.id === selected ? ' active' : ''); r.style.setProperty('--depth', String(depth))
    const indent = document.createElement('span'); indent.className = 'indent'; r.append(indent)
    const kids = children.get(item.id) || []
    const toggle = button(kids.length ? (expanded.has(item.id) ? '▾' : '›') : '·', 'toggle', () => { expanded.has(item.id) ? expanded.delete(item.id) : expanded.add(item.id); render() }); toggle.disabled = !kids.length; r.append(toggle)
    const check = button(item.done ? '✓' : '', 'check' + (item.done ? ' done' : ''), () => change({ action: 'update', id: item.id, itemRevision: item.revision, item: { done: !item.done } })); check.title = item.done ? 'Reopen' : 'Mark complete'; r.append(check)
    const main = button('', 'row-main', () => { selected = item.id; render() }); const strong = document.createElement('strong'), small = document.createElement('small'); strong.textContent = item.title; small.textContent = item.description || item.notes || (outcome ? `${kids.length} connected item${kids.length === 1 ? '' : 's'}` : 'No details yet'); main.append(strong, small); r.append(main)
    if (outcome) { const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = 'OUTCOME'; r.append(badge) }
    if (focused.has(item.id)) { const badge = document.createElement('span'); badge.className = 'badge focus'; badge.textContent = 'FOCUS ' + (state.focus.indexOf(item.id) + 1); r.append(badge) }
    r.append(button(focused.has(item.id) ? '− Focus' : '+ Focus', 'quick', () => change({ action: 'focus', id: item.id, focused: !focused.has(item.id), revision: state.revision })))
    return r
  }
  const nodes = []
  if (view === 'map') for (const root of children.get('') || []) {
    const containsMatch = (x) => visible(x) || (children.get(x.id) || []).some(containsMatch); if (!containsMatch(root)) continue
    const group = document.createElement('section'); group.className = 'outcome'; group.append(row(root, 0, true))
    const branch = (parent, depth) => { if (!expanded.has(parent.id) && !query) return; for (const child of children.get(parent.id) || []) if (containsMatch(child)) { group.append(row(child, depth)); branch(child, depth + 1) } }
    branch(root, 1); nodes.push(group)
  } else {
    let list = items.filter(visible); if (view === 'focus') list.sort((a,b) => state.focus.indexOf(a.id) - state.focus.indexOf(b.id))
    const group = document.createElement('section'); group.className = 'outcome'; for (const item of list) group.append(row(item, 0)); if (list.length) nodes.push(group)
  }
  if (!nodes.length) { const e = document.createElement('div'); e.className = 'empty'; e.textContent = query ? 'No work matches this filter.' : view === 'focus' ? 'Your focus is clear. Add an item from the map.' : 'Nothing here yet.'; nodes.push(e) }
  $('list').replaceChildren(...nodes); renderDetail(map.get(selected))
}
const expanded = new Set()
function pathsToGoals(start, map, goals) {
  const neighbors = (id) => { const x = map.get(id); if (!x) return []; const result = [x.parentId, ...x.dependencies, ...x.links]; for (const other of map.values()) if (other.dependencies.includes(id) || other.links.includes(id)) result.push(other.id); return [...new Set(result.filter(Boolean))] }
  const queue = [[start]], found = []; while (queue.length && found.length < 8) { const path = queue.shift(), at = path[path.length - 1]; if (path.length > 1 && goals.has(at)) { found.push(path); continue } if (path.length >= 8) continue; for (const next of neighbors(at)) if (!path.includes(next)) queue.push([...path, next]) } return found
}
function renderAlignment(map, goals) {
  const active = map.get(state.active), nodes = []; $('detail').hidden = true
  if (!active) { const e = document.createElement('div'); e.className = 'empty'; e.textContent = 'Choose “Work on this” from an item to map active work back to pinned goals.'; nodes.push(e) }
  else { const head = document.createElement('section'); head.className = 'alignment-head'; const eye=document.createElement('p');eye.className='eyebrow';eye.textContent='ACTIVE WORK';const h=document.createElement('h2');h.textContent=active.title;head.append(eye,h,button('Clear active item','',()=>change({action:'active',id:null,revision:state.revision})));nodes.push(head); const paths=pathsToGoals(active.id,map,goals); if(!paths.length){const e=document.createElement('div');e.className='empty';e.textContent='No path from this item to a pinned goal yet. Add a parent, dependency, or related-work link.';nodes.push(e)} for(const path of paths){const card=document.createElement('section');card.className='path-card';path.forEach((id,i)=>{const x=map.get(id), step=document.createElement('div');step.className='path-step';const label=document.createElement('small');label.textContent=i===0?'ACTIVE':goals.has(id)?'PINNED GOAL':'CONNECTION';const title=document.createElement('strong');title.textContent=x.title;step.append(label,title);card.append(step);if(i<path.length-1){const arrow=document.createElement('span');arrow.className='path-arrow';arrow.textContent='↓';card.append(arrow)}});nodes.push(card)} }
  $('list').replaceChildren(...nodes)
}
function renderDetail(item) {
  if (!item) { $('detail').hidden = true; return } $('detail').hidden = false
  const map = byId(), parent = map.get(item.parentId), focusAt = state.focus.indexOf(item.id)
  const eye = document.createElement('p'); eye.className = 'eyebrow'; eye.textContent = item.done ? 'COMPLETED' : focusAt >= 0 ? 'FOCUS #' + (focusAt + 1) : 'WORK ITEM'
  const h = document.createElement('h2'); h.textContent = item.title
  const meta = document.createElement('p'); meta.className = 'meta'; meta.textContent = parent ? 'Under ' + parent.title : 'Top-level outcome'
  const desc = document.createElement('p'); desc.textContent = item.description || 'No description.'
  const notes = document.createElement('p'); notes.textContent = item.notes; notes.hidden = !item.notes
  const actions = document.createElement('div'); actions.className = 'actions'; actions.append(button('Edit', '', () => openEditor(item)), button(state.active === item.id ? 'Active now' : 'Work on this', state.active === item.id ? 'primary' : '', () => change({ action: 'active', id: state.active === item.id ? null : item.id, revision: state.revision })))
  if (focusAt >= 0) { actions.append(button('↑', '', () => change({ action: 'moveFocus', id: item.id, direction: 'up', revision: state.revision })), button('↓', '', () => change({ action: 'moveFocus', id: item.id, direction: 'down', revision: state.revision }))) }
  actions.append(button('Close', '', () => { selected = null; render() })); $('detail').replaceChildren(eye, h, meta, desc, notes, actions)
}
function openEditor(item = null) {
  editing = item; $('form-heading').textContent = item ? 'Edit work item' : 'Add to plan'; $('title').value = item?.title || ''; $('description').value = item?.description || ''; $('notes').value = item?.notes || ''
  const excluded = item ? descendants(item.id) : new Set(), options = [new Option('Top level outcome', '')]
  for (const x of state.items.filter((x) => !excluded.has(x.id) && !x.done)) options.push(new Option(x.title, x.id)); $('parent').replaceChildren(...options); $('parent').value = item?.parentId || ''; const relations = state.items.filter((x) => !excluded.has(x.id)).map((x) => new Option(x.title, x.id)); $('dependencies').replaceChildren(...relations.map((x) => x.cloneNode(true))); $('links').replaceChildren(...relations); for (const o of $('dependencies').options) o.selected = item?.dependencies.includes(o.value) || false; for (const o of $('links').options) o.selected = item?.links.includes(o.value) || false; $('delete').hidden = !item; $('editor').showModal(); $('title').focus()
}
$('add').onclick = () => openEditor(); $('close').onclick = $('cancel').onclick = () => $('editor').close()
$('delete').onclick = () => { if (editing && confirm(`Delete “${editing.title}”? Children will move up one level.`)) { $('editor').close(); change({ action: 'delete', id: editing.id, itemRevision: editing.revision }) } }
$('form').onsubmit = (event) => { event.preventDefault(); const item = { title: $('title').value.trim(), description: $('description').value, notes: $('notes').value, done: editing?.done || false }; if (!item.title) return; $('editor').close(); change(editing ? { action: 'update', id: editing.id, itemRevision: editing.revision, parentId: $('parent').value || null, dependencies: [...$('dependencies').selectedOptions].map((x) => x.value), links: [...$('links').selectedOptions].map((x) => x.value), item } : { action: 'add', revision: state.revision, parentId: $('parent').value || null, item }) }
async function change(command) { if (busy) return; busy = true; try { state = await api('/work-plan', 'POST', { command }); notice('Plan saved.'); render() } catch (e) { notice(e.message); if (e.status === 409) state = await api('/work-plan'); render() } finally { busy = false } }
for (const b of document.querySelectorAll('.tabs button')) b.onclick = () => { view = b.dataset.view; render() }; $('search').oninput = render
async function enter() { state = await api('/work-plan'); $('login').hidden = true; $('app').hidden = false; for (const x of state.items) if (!x.parentId) expanded.add(x.id); render() }
$('login-form').onsubmit = async (event) => { event.preventDefault(); try { await api('/login', 'POST', { token: $('token').value.trim() }); $('token').value = ''; await enter() } catch (e) { notice(e.message) } }
void enter().catch((e) => { if (e.message !== 'Sign in required') notice(e.message) })
