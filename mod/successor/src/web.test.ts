import { expect, test } from 'bun:test'
import { mkdtemp, rm, stat, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, credential } from './web.ts'

async function fixture(agentOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'successor-web-'))
  const token = await credential(directory)
  const app = await createApp({ directory, token, apiKey: 'test', agentOptions })
  let cookie = ''
  const request = (path: string, method = 'GET', data?: unknown, origin = 'http://localhost') =>
    app.fetch(new Request('http://localhost/api' + path, {
      method, headers: { origin, cookie, 'content-type': 'application/json' },
      body: data === undefined ? undefined : JSON.stringify(data),
    }))
  const login = async () => {
    const response = await request('/login', 'POST', { token })
    cookie = response.headers.get('set-cookie')!.split(';')[0]!
    return response
  }
  return { directory, token, app, request, login, cleanup: () => rm(directory, { recursive: true, force: true }) }
}
const message = (text: string) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] })

test('private stable credential; authentication, CSRF, logout and safe static routes', async () => {
  const f = await fixture()
  try {
    expect(await credential(f.directory)).toBe(f.token)
    expect((await stat(join(f.directory, 'access-token'))).mode & 0o777).toBe(0o600)
    expect((await f.request('/conversations')).status).toBe(401)
    expect((await f.request('/login', 'POST', { token: f.token }, 'https://evil.example')).status).toBe(403)
    expect((await f.request('/login', 'POST', { token: 'wrong' })).status).toBe(401)
    expect((await f.login()).headers.get('set-cookie')).toContain('HttpOnly; SameSite=Strict')
    expect((await f.request('/conversations')).status).toBe(200)
    expect((await f.request('/conversations', 'POST', {}, 'https://evil.example')).status).toBe(403)
    const home = await f.app.fetch(new Request('http://localhost/'))
    expect(home.headers.get('content-security-policy')).toContain("script-src 'self'")
    expect((await f.app.fetch(new Request('http://localhost/access-token'))).status).toBe(404)
    expect((await f.request('/logout', 'POST', {})).headers.get('set-cookie')).toContain('Max-Age=0')
  } finally { await f.cleanup() }
})

test('independent histories, serialized turns, duplicate rejection and persistence', async () => {
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  const requests: any[] = []
  const f = await fixture({
    fetch: async (_: string, init: RequestInit) => {
      requests.push(JSON.parse(init.body as string))
      await gate
      return Response.json({ status: 'completed', output: [{ type: 'reasoning', encrypted_content: 'private-opaque' }, message('Done')] })
    },
  })
  try {
    await f.login()
    const a: any = await (await f.request('/conversations', 'POST', {})).json()
    const b: any = await (await f.request('/conversations', 'POST', {})).json()
    expect((await f.request(`/conversations/${a.id}/turn`, 'POST', { input: 'First only' })).status).toBe(202)
    expect((await f.request(`/conversations/${a.id}/turn`, 'POST', { input: 'duplicate' })).status).toBe(409)
    expect((await f.request(`/conversations/${b.id}/turn`, 'POST', { input: 'Second only' })).status).toBe(202)
    await Bun.sleep(20)
    expect(requests).toHaveLength(1)
    expect(((await (await f.request(`/conversations/${b.id}`)).json()) as any).status).toBe('queued')
    // Metadata writes are serialized with running checkpoints.
    expect((await f.request(`/conversations/${a.id}`, 'PATCH', { title: 'Renamed' })).status).toBe(200)
    release()
    await f.app.drained()
    expect(requests).toHaveLength(2)
    expect(requests[1].input).toEqual([{ role: 'user', content: 'Second only' }])
    const view: any = await (await f.request(`/conversations/${a.id}`)).json()
    expect(view.title).toBe('Renamed')
    expect(view.status).toBe('idle')
    expect(JSON.stringify(view)).not.toContain('private-opaque')
    expect(view.messages.map((m: any) => m.text)).toEqual(['First only', 'Done'])
    const saved = await Bun.file(join(f.directory, `${a.id}.json`)).json()
    expect(saved.session.messages.some((m: any) => m.encrypted_content === 'private-opaque')).toBe(true)
    expect((await stat(join(f.directory, `${a.id}.json`))).mode & 0o777).toBe(0o600)
    expect((await f.request(`/conversations/${a.id}/turn`, 'POST', { retry: true })).status).toBe(409)
    expect((await f.request(`/conversations/${a.id}/turn`, 'POST', { input: 'x'.repeat(70_000) })).status).toBe(400)
  } finally { release(); await f.app.drained(); await f.cleanup() }
})

test('restart marks interrupted commands without replay and permits explicit retry', async () => {
  const f = await fixture()
  try {
    await f.login()
    const c: any = await (await f.request('/conversations', 'POST', {})).json()
    const path = join(f.directory, `${c.id}.json`)
    const saved = await Bun.file(path).json()
    saved.status = 'running'
    saved.session.messages.push({ type: 'custom_tool_call', name: 'bash', input: 'do-not-run', call_id: 'uncertain' })
    await Bun.write(path, JSON.stringify(saved))
    let runs = 0
    const restarted = await createApp({
      directory: f.directory, token: f.token, apiKey: 'test',
      agentOptions: { run: async () => { runs++; return '' }, fetch: async () => Response.json({ status: 'completed', output: [message('Reviewed')] }) },
    })
    const login = await restarted.fetch(new Request('http://localhost/api/login', {
      method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json' }, body: JSON.stringify({ token: f.token }),
    }))
    const headers = { cookie: login.headers.get('set-cookie')!.split(';')[0]!, origin: 'http://localhost', 'content-type': 'application/json' }
    const read = () => restarted.fetch(new Request(`http://localhost/api/conversations/${c.id}`, { headers }))
    const view: any = await (await read()).json()
    expect(view.status).toBe('interrupted')
    expect(view.messages.at(-1).text).toContain('may have run')
    expect(runs).toBe(0)
    expect((await restarted.fetch(new Request(`http://localhost/api/conversations/${c.id}/turn`, {
      method: 'POST', headers, body: JSON.stringify({ retry: true }),
    }))).status).toBe(202)
    await restarted.drained()
    expect(((await (await read()).json()) as any).status).toBe('idle')
    expect(runs).toBe(0)
    expect((await readdir(f.directory)).some((name) => name.endsWith('.tmp'))).toBe(false)
  } finally { await f.cleanup() }
})

test('failures retain input without leaking upstream error details', async () => {
  const f = await fixture({ fetch: async () => { throw new Error('SECRET-UPSTREAM') } })
  try {
    await f.login()
    const c: any = await (await f.request('/conversations', 'POST', {})).json()
    await f.request(`/conversations/${c.id}/turn`, 'POST', { input: 'Remember this' })
    await f.app.drained()
    const view: any = await (await f.request(`/conversations/${c.id}`)).json()
    expect(view.status).toBe('error')
    expect(view.messages[0].text).toBe('Remember this')
    expect(JSON.stringify(view)).not.toContain('SECRET-UPSTREAM')
    expect(view.error).toContain('Unknown failure')
    expect(view.attempt.category).toBe('unknown')
  } finally { await f.cleanup() }
})

test('authenticated provider catalog and per-conversation settings validate, lock, route and survive restart', async () => {
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  const requests: any[] = []
  const f = await fixture({
    fetch: async (url: string, init: RequestInit) => {
      requests.push({ url, body: JSON.parse(init.body as string) })
      await gate
      return Response.json({ status: 'completed', output: [message('Done')] })
    },
  })
  try {
    expect((await f.request('/providers')).status).toBe(401)
    await f.login()
    const config: any = await (await f.request('/providers')).json()
    expect(config.providers.some((p: any) => p.id === 'anthropic')).toBe(true)
    expect(JSON.stringify(config)).not.toContain('"apiKey"')
    expect(JSON.stringify(config)).not.toContain('baseURL')
    const a: any = await (await f.request('/conversations', 'POST', {})).json()
    const b: any = await (await f.request('/conversations', 'POST', {})).json()
    const settings = { provider: 'openai', model: 'gpt-5.2', reasoning: 'high' }
    expect((await f.request(`/conversations/${a.id}`, 'PATCH', { selection: settings }, 'https://evil.example')).status).toBe(403)
    expect((await f.request(`/conversations/${a.id}`, 'PATCH', { selection: { ...settings, reasoning: 'bogus' } })).status).toBe(400)
    expect((await f.request(`/conversations/${a.id}`, 'PATCH', { selection: { ...settings, provider: 'claude-subscription' } })).status).toBe(400)
    expect((await f.request(`/conversations/${a.id}`, 'PATCH', { selection: { ...settings, apiKey: 'do-not-store' } })).status).toBe(400)
    expect((await f.request(`/conversations/${a.id}`, 'PATCH', { selection: settings })).status).toBe(200)
    expect((await f.request(`/conversations/${a.id}/turn`, 'POST', { input: 'hello' })).status).toBe(202)
    expect((await f.request(`/conversations/${a.id}`, 'PATCH', { selection: { ...settings, reasoning: 'low' } })).status).toBe(409)
    await Bun.sleep(10)
    expect(requests[0].body.model).toBe('gpt-5.2')
    expect(requests[0].body.reasoning).toEqual({ effort: 'high' })
    const other: any = await (await f.request(`/conversations/${b.id}`)).json()
    expect(other.selection).toEqual(config.defaults)
    release(); await f.app.drained()
    const restarted = await createApp({ directory: f.directory, token: f.token, apiKey: 'test' })
    const login = await restarted.fetch(new Request('http://localhost/api/login', {
      method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json' },
      body: JSON.stringify({ token: f.token }),
    }))
    const view: any = await (await restarted.fetch(new Request(`http://localhost/api/conversations/${a.id}`, {
      headers: { cookie: login.headers.get('set-cookie')!.split(';')[0]! },
    }))).json()
    expect(view.selection).toEqual(settings)
  } finally { release(); await f.app.drained(); await f.cleanup() }
})

test('web starts without an OpenAI key and sends through another configured provider', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'successor-no-openai-'))
  try {
    let requested = false
    const app = await createApp({
      directory, token: 'test-access-token',
      env: { AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'private-test-key' },
      agentOptions: { fetch: async (url, init) => {
        requested = true
        expect(url).toBe('https://api.anthropic.com/v1/messages')
        expect((init.headers as any)['x-api-key']).toBe('private-test-key')
        return Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Hi' }] })
      } },
    })
    const headers = { origin: 'http://localhost', 'content-type': 'application/json', cookie: '' }
    const req = (path: string, method: string, body?: unknown) => app.fetch(new Request('http://localhost/api' + path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    }))
    const login = await req('/login', 'POST', { token: 'test-access-token' })
    headers.cookie = login.headers.get('set-cookie')!.split(';')[0]!
    const c: any = await (await req('/conversations', 'POST', {})).json()
    expect(c.selection.provider).toBe('anthropic')
    expect((await req(`/conversations/${c.id}/turn`, 'POST', { input: 'Hi' })).status).toBe(202)
    await app.drained()
    expect(requested).toBe(true)
    const view = await (await req(`/conversations/${c.id}`, 'GET')).text()
    expect(view).not.toContain('private-test-key')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('tool-step limit explains how to continue and retry does not replay completed commands', async () => {
  let runs = 0
  const requests: any[] = []
  const f = await fixture({
    maxSteps: 1,
    fetch: async (_: string, init: RequestInit) => {
      requests.push(JSON.parse(init.body as string))
      return Response.json({ status: 'completed', output: requests.length === 1
        ? [{ type: 'custom_tool_call', name: 'bash', input: 'example', call_id: 'completed-call' }]
        : [message('Done')] })
    },
    run: async () => { runs++; return 'saved result' },
  })
  try {
    await f.login()
    const c: any = await (await f.request('/conversations', 'POST', {})).json()
    await f.request(`/conversations/${c.id}/turn`, 'POST', { input: 'Continue this task' })
    await f.app.drained()
    const view: any = await (await f.request(`/conversations/${c.id}`)).json()
    expect(view.status).toBe('error')
    expect(view.error).toContain('Tool-step limit reached')
    expect(view.error).toContain('Retry to continue')
    expect(view.error).not.toContain('API connectivity')
    const saved = await Bun.file(join(f.directory, `${c.id}.json`)).json()
    expect(saved.error).toBe(view.error)
    expect(saved.session.messages.at(-1).output).toBe('saved result')

    expect((await f.request(`/conversations/${c.id}/turn`, 'POST', { retry: true })).status).toBe(202)
    await f.app.drained()
    expect(runs).toBe(1)
    expect(requests).toHaveLength(2)
    expect(requests[1].input.at(-1)).toMatchObject({
      call_id: 'completed-call', output: 'saved result',
    })
    const continued: any = await (await f.request(`/conversations/${c.id}`)).json()
    expect(continued.status).toBe('idle')
    expect(continued.error).toBeUndefined()
    expect(continued.messages.at(-1).text).toBe('Done')
  } finally { await f.app.drained(); await f.cleanup() }
})

test('work queue API requires authentication and same-origin writes, persists independently of conversations', async () => {
  const f = await fixture()
  try {
    const data = { revision: 0, command: { action: 'add', item: { title: 'Plan release', description: 'Run checks', notes: 'Ask for review', done: false } } }
    expect((await f.request('/work-queue')).status).toBe(401)
    expect((await f.request('/work-queue', 'POST', data)).status).toBe(401)
    await f.login()
    expect((await f.request('/work-queue', 'POST', data, 'https://evil.example')).status).toBe(403)
    expect((await f.request('/work-queue', 'POST', data)).status).toBe(200)
    expect((await f.request('/work-queue', 'POST', data)).status).toBe(409)
    const state: any = await (await f.request('/work-queue')).json()
    expect(state.items[0].notes).toBe('Ask for review')
    expect(await (await f.request('/conversations')).json()).toEqual([])
    expect((await f.request('/work-queue', 'POST', { ...data, revision: 1, command: { action: 'run' } })).status).toBe(400)
    expect((await f.app.fetch(new Request('http://localhost/work-queue.json'))).status).toBe(404)
  } finally { await f.cleanup() }
})
