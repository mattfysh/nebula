import { beginAttempt, finishAttempt, recoverAttempts, diagnosticSummary, DiagnosticError, failure, advice } from './diagnostics.ts'
import { mkdir, readFile, readdir, rename, writeFile, open } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { workQueue } from './work-queue.ts'
import { workGraph } from './work-graph/store.ts'
import { ChatGPTAuth, ChatGPTError } from './chatgpt-auth.ts'
import { chatgptModels } from './chatgpt.ts'
import { discoverModels } from './model-discovery.ts'
import { Agent, Session, recover } from './agent.ts'
import { usageSummary } from './usage.ts'
import { Selection, loadProviders, defaultSelection, validateSelection, catalog, type Provider, type Environment, type Discovery } from './providers.ts'

const RecordSchema = z.object({
  id: z.string().uuid(), title: z.string(), updated: z.string(),
  status: z.enum(['idle', 'queued', 'running', 'error', 'interrupted']),
  error: z.string().optional(), session: Session,
})
type Conversation = z.infer<typeof RecordSchema>
const uuid = z.string().uuid()
const tokenHash = (value: string) => createHash('sha256').update(value).digest()
const equal = (a: string, b: string) => timingSafeEqual(tokenHash(a), tokenHash(b))

async function atomic(path: string, value: unknown) {
  await writeFile(path + '.tmp', JSON.stringify(value) + '\n', { mode: 0o600 })
  await rename(path + '.tmp', path)
}

export async function credential(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, 'access-token')
  // Exclusive creation; never overwrite an existing credential.
  try {
    const file = await open(path, 'wx', 0o600)
    try { await file.writeFile(randomBytes(32).toString('base64url') + '\n') }
    finally { await file.close() }
  } catch (error: any) { if (error.code !== 'EEXIST') throw error }
  const token = (await readFile(path, 'utf8')).trim()
  if (token.length < 32) throw new Error('Invalid access-token file')
  return token
}

// Only explicitly displayable items go to the browser, never opaque reasoning.
export function transcript(session: Session) {
  return session.messages.flatMap((m) => {
    if (m.type === 'custom_tool_call')
      return [{ kind: 'command', text: String(m.input ?? '') }]
    if (m.type === 'custom_tool_call_output')
      return [{ kind: 'result', text: String(m.output ?? '') }]
    if (m.role === 'user' || m.role === 'assistant') {
      const text = typeof m.content === 'string' ? m.content :
        Array.isArray(m.content) ? m.content.map((b) => b.text ?? b.refusal ?? '').join('\n') : ''
      return text ? [{ kind: m.role as string, text }] : []
    }
    return []
  })
}

export async function createApp(options: {
  directory: string, token: string, apiKey?: string, model?: string,
  providers?: Provider[], env?: Environment,
  seed?: string,
  chatgptAuth?: ChatGPTAuth,
  agentOptions?: Partial<ConstructorParameters<typeof Agent>[1]>,
}) {
  const env = { ...(options.env ?? process.env) }
  if (options.apiKey) env.OPENAI_API_KEY = options.apiKey
  if (options.model) env.OPENAI_MODEL = options.model
  const providers = options.providers ?? await loadProviders(env)
  const directory = resolve(options.directory)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const work = await workQueue(directory)
  const plan = await workGraph(directory)
  const chatgpt = options.chatgptAuth ?? await ChatGPTAuth.open(directory)
  const subscription = providers.find((p) => p.protocol === 'chatgpt')
  const discoveries = new Map<string, Discovery>(providers.map((provider) => [provider.id, { status: 'pending' }]))
  let modelFlight: Promise<void> | undefined, modelChecked = 0, modelGeneration = 0
  const resetModels = () => {
    modelGeneration++; modelChecked = 0
    if (subscription) subscription.models = []
    if (subscription) discoveries.set(subscription.id, { status: 'pending' })
  }
  const refreshModels = async () => {
    if (modelFlight) return modelFlight
    if (Date.now() - modelChecked < 30_000) return
    modelChecked = Date.now()
    const generation = modelGeneration
    modelFlight = (async () => {
      try {
        const models = await chatgptModels(chatgpt, options.agentOptions?.fetch)
        if (generation !== modelGeneration || !chatgpt.status().connected || !subscription) return
        subscription.models = models
        discoveries.set(subscription.id, { status: 'ready' })
        subscription.note = 'Model capabilities loaded from the signed-in ChatGPT account.'
      } catch (error) {
        if (generation !== modelGeneration) return
        const reason = error instanceof ChatGPTError ? error.message : 'Model metadata response was not recognized.'
        console.error('[ChatGPT] model discovery failed:', reason)
        if (subscription) {
          subscription.models = []
          discoveries.set(subscription.id, { status: 'error', error: 'ChatGPT model catalog lookup failed. Refresh models or reconnect.' })
          subscription.note = 'Model catalog unavailable; this provider cannot be used.'
        }
      }
    })().finally(() => { modelFlight = undefined })
    return modelFlight
  }
  // Catalog lookup is authoritative. Providers remain unavailable on any failure.
  for (const provider of providers) {
    if (provider.protocol === 'chatgpt') {
      if (chatgpt.status().connected) await refreshModels()
      else discoveries.set(provider.id, { status: 'error', error: 'Connect ChatGPT to load models.' })
      continue
    }
    if (!['responses', 'chat', 'anthropic'].includes(provider.protocol)) {
      discoveries.set(provider.id, { status: 'error', error: 'Model discovery is not integrated for this provider.' })
      continue
    }
    try {
      provider.models = await discoverModels(provider, env, options.agentOptions?.fetch)
      discoveries.set(provider.id, { status: 'ready' })
    } catch {
      provider.models = []
      discoveries.set(provider.id, { status: 'error', error: 'Model catalog lookup failed. Check provider credentials and endpoint.' })
    }
  }
  let defaults: ReturnType<typeof defaultSelection> | undefined
  try { defaults = defaultSelection(providers, env) } catch {}

  const conversations = new Map<string, Conversation>()
  const writes = new Map<string, Promise<void>>()
  const persist = (c: Conversation) => {
    const snapshot = structuredClone(c)
    const next = (writes.get(c.id) ?? Promise.resolve()).catch(() => {}).then(
      () => atomic(join(directory, `${c.id}.json`), snapshot),
    )
    writes.set(c.id, next)
    return next
  }
  for (const name of await readdir(directory)) {
    if (!name.endsWith('.json') || !uuid.safeParse(name.slice(0, -5)).success) continue
    const c = RecordSchema.parse(JSON.parse(await readFile(join(directory, name), 'utf8')))
    if (name !== `${c.id}.json`) throw new Error('Conversation filename mismatch')
    recover(c.session)
    if (!c.session.selection && defaults) c.session.selection = defaults
    // Old generic errors have no reliable cause. Do not inspect old raw payloads.
    if (!c.session.diagnostics?.length && ['error', 'interrupted', 'queued', 'running'].includes(c.status)) {
      const legacy = beginAttempt(c.session, c.session.selection)
      legacy.timingUnknown = true
      finishAttempt(legacy, new DiagnosticError(['queued', 'running', 'interrupted'].includes(c.status) ? 'interruption' : 'unknown'))
    }
    recoverAttempts(c.session)
    if (c.error) c.error = advice[c.session.diagnostics?.at(-1)?.category ?? 'unknown']
    if (c.status === 'queued' || c.status === 'running') {
      const last = c.session.diagnostics?.at(-1)
      c.status = last?.status === 'succeeded' ? 'idle' : last?.status === 'failed' ? 'error' : 'interrupted'
      if (last?.category) c.error = advice[last.category]
      else delete c.error
    }
    await persist(c)
    conversations.set(c.id, c)
  }
  const create = async (title: string, session: Session = { version: 1, messages: [] }) => {
    if (!session.selection && !defaults) throw new Error('No usable provider model catalog. Check provider status.')
    recoverAttempts(session)
    const c: Conversation = { id: crypto.randomUUID(), title, updated: new Date().toISOString(), status: 'idle', session }
    recover(c.session)
    if (!c.session.selection && defaults) c.session.selection = defaults
    await persist(c)
    conversations.set(c.id, c)
    return c
  }
  // Import once, as an independent snapshot. Never write the CLI's live session.
  if (!conversations.size && options.seed && await Bun.file(options.seed).exists())
    await create('CLI conversation (imported snapshot)', Session.parse(await Bun.file(options.seed).json()))

  // Live text is intentionally ephemeral: only completed, validated output is persisted.
  // Subscribers receive deltas while a turn runs, then a reset and authoritative refresh.
  const liveText = new Map<string, string>()
  // One application-wide event stream replaces per-conversation streams and polling.
  const subscribers = new Set<ReadableStreamDefaultController<Uint8Array>>()
  const encoder = new TextEncoder()
  const publish = (id: string, event: string, data: Record<string, unknown>) => {
    const chunk = encoder.encode(`event: ${event}\ndata: ${JSON.stringify({ id, ...data })}\n\n`)
    for (const controller of subscribers) {
      try { controller.enqueue(chunk) } catch { subscribers.delete(controller) }
    }
  }
  const stream = (id: string, text: string | null) => {
    if (text === null) { liveText.delete(id); publish(id, 'reset', {}) }
    else { liveText.set(id, (liveText.get(id) ?? '') + text); publish(id, 'delta', { text }) }
  }
  // Keep idle SSE connections alive through browser/proxy idle timeouts.
  const heartbeat = setInterval(() => {
    const chunk = encoder.encode(': keepalive\n\n')
    for (const controller of subscribers) {
      try { controller.enqueue(chunk) } catch { subscribers.delete(controller) }
    }
  }, 15_000)
  const closeStreams = () => {
    clearInterval(heartbeat)
    for (const controller of subscribers) { try { controller.close() } catch {} }
    subscribers.clear()
  }
  let connectionChanging = false
  // Run up to three independent conversations at once. Additional turns remain
  // queued; the existing status guard still permits only one turn per conversation.
  const maxParallelTurns = 3
  let runningTurns = 0
  const pendingTurns: Array<() => void> = []
  const drainWaiters = new Set<() => void>()
  const schedule = (task: () => Promise<void>) => {
    const run = () => {
      runningTurns++
      void task().catch(() => {
        console.error('Conversation checkpoint failed; check disk permissions and space.')
      }).finally(() => {
        runningTurns--
        pendingTurns.shift()?.()
        if (!runningTurns && !pendingTurns.length) {
          for (const resolve of drainWaiters) resolve()
          drainWaiters.clear()
        }
      })
    }
    if (runningTurns < maxParallelTurns) run()
    else pendingTurns.push(run)
  }
  const turnsDrained = () => !runningTurns && !pendingTurns.length
    ? Promise.resolve()
    : new Promise<void>((resolve) => drainWaiters.add(resolve))
  const enqueue = async (c: Conversation, input?: string) => {
    if (c.status === 'running' || c.status === 'queued') return false
    const attempt = beginAttempt(c.session, c.session.selection ?? defaults, input === undefined)
    c.status = 'queued'
    // Prior diagnostics and the last failure are never erased on enqueue.
    try {
      let selected: ReturnType<typeof validateSelection>
      try {
        if (!c.session.selection && !defaults) throw new Error('No model catalog')
        selected = validateSelection(c.session.selection ?? defaults!, providers, env, discoveries) }
      catch { throw new DiagnosticError('configuration') }
      if (selected.provider.protocol === 'chatgpt' && (connectionChanging || !chatgpt.status().connected))
        throw new DiagnosticError('auth')
    } catch (error) {
      finishAttempt(attempt, error); c.status = 'error'; c.error = failure(error).message
      try { await persist(c) } catch { attempt.storageFailed = true }
      throw failure(error)
    }
    c.updated = new Date().toISOString()
    if (input !== undefined) {
      c.session.messages.push({ role: 'user', content: input })
      if (c.title === 'New conversation') c.title = input.slice(0, 70)
    }
    // Set the lock before any await, including disk writes.
    try { await persist(c) }
    catch {
      finishAttempt(attempt, new DiagnosticError('storage')); attempt.storageFailed = true
      c.status = 'error'; c.error = advice.storage
      try { await persist(c) } catch { /* In-memory status remains available while disk is unavailable. */ }
      throw new DiagnosticError('storage')
    }
    schedule(async () => {
      try {
        c.status = 'running'
        try { await persist(c) } catch { attempt.storageFailed = true; attempt.phase = 'checkpoint'; throw new DiagnosticError('storage') }
        let visibleTranscript = JSON.stringify(transcript(c.session))
        const agent = new Agent(c.session, {
          ...options.agentOptions,
          env, providers, chatgpt, model: options.model,
          selection: c.session.selection, attempt,
          checkpoint: async () => {
            c.updated = new Date().toISOString()
            await persist(c)
            const nextTranscript = JSON.stringify(transcript(c.session))
            if (nextTranscript !== visibleTranscript) {
              visibleTranscript = nextTranscript
              publish(c.id, "refresh", {})
            }
          },
          stream: (text) => stream(c.id, text),
        })
        await agent.turn(undefined, () => {})
        c.status = 'idle'
        delete c.error
      } catch (error) {
        recover(c.session)
        c.status = 'error'
        if (['queued', 'running'].includes(attempt.status)) finishAttempt(attempt, error)
        c.status = attempt.status === 'interrupted' ? 'interrupted' : 'error'
        c.error = advice[attempt.category ?? 'unknown']
      } finally {
        // Retract partial output on errors and tell clients to load committed history.
        stream(c.id, null)
        c.updated = new Date().toISOString()
        try { await persist(c) }
        catch {
          attempt.storageFailed = true
          if (!attempt.category) finishAttempt(attempt, new DiagnosticError('storage'))
          c.status = 'error'; c.error = advice.storage
          try { await persist(c) } catch { console.error('Conversation checkpoint failed; check disk permissions and space. Diagnostics are in memory only until storage works.') }
        }
        publish(c.id, 'refresh', {})
      }
    })
    return true
  }
  const cookieValue = createHash('sha256').update('web-session:' + options.token).digest('hex')
  const headers = {
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
  }
  const json = (value: unknown, status = 200, extra = {}) =>
    Response.json(value, { status, headers: { ...headers, ...extra } })
  const summary = (c: Conversation) => {
    const selection = c.session.selection ?? defaults
    if (!selection) return { id: c.id, title: c.title, status: c.status, updated: c.updated, error: 'No usable provider model catalog.', selection: null, usage: usageSummary(c.session.usage, undefined) }
    return { id: c.id, title: c.title, status: c.status, updated: c.updated, error: c.error, attempt: c.session.diagnostics?.at(-1) ? diagnosticSummary(c.session.diagnostics.at(-1)!) : undefined, selection, usage: usageSummary(c.session.usage, providers.find((p) => p.id === selection.provider)) }
  }
  let loginWindow = 0, attempts = 0

  const handler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    const path = url.pathname
    if (req.method !== 'GET') {
      // Reject cross-origin and non-JSON writes, including login CSRF.
      const origin = req.headers.get('origin')
      if (!origin || !['http:', 'https:'].some((protocol) => origin === `${protocol}//${url.host}`))
        return json({ error: 'Origin rejected' }, 403)
      if (!req.headers.get('content-type')?.startsWith('application/json'))
        return json({ error: 'JSON required' }, 415)
    }
    const body = async () => {
      // Bound decoded bodies too; don't rely on client-provided Content-Length.
      const reader = req.body?.getReader()
      if (!reader) throw new Error('Missing body')
      const chunks: Uint8Array[] = []
      let length = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        length += value.length
        if (length > 65_536) { await reader.cancel(); throw new Error('Body too large') }
        chunks.push(value)
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    }
    if (path === '/api/login' && req.method === 'POST') {
      const now = Date.now()
      if (now - loginWindow > 60_000) { loginWindow = now; attempts = 0 }
      if (++attempts > 20) return json({ error: 'Too many attempts; wait a minute' }, 429)
      const data = await body()
      if (typeof data.token !== 'string' || !equal(data.token, options.token))
        return json({ error: 'Invalid access token' }, 401)
      // This server binds only to loopback. cloudflared supplies the HTTPS header.
      const secure = url.protocol === 'https:' || req.headers.get('x-forwarded-proto') === 'https'
      return json({ ok: true }, 200, { 'set-cookie': `successor=${cookieValue}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${secure ? '; Secure' : ''}` })
    }
    if (path.startsWith('/api/')) {
      const cookie = req.headers.get('cookie')?.split(';').map((s) => s.trim()).find((s) => s.startsWith('successor='))?.slice(10)
      if (!cookie || !equal(cookie, cookieValue)) return json({ error: 'Sign in required' }, 401)
      if (path === '/api/work-plan') {
        if (req.method === 'GET') return json(plan.read())
        if (req.method === 'POST') { const result = await plan.change(await body()); return json(result.body, result.status) }
      }
      if (path === '/api/work-queue') {
        if (req.method === 'GET') return json(work.read())
        if (req.method === 'POST') {
          const result = await work.change(await body())
          return json(result.body, result.status)
        }
      }
      if (path === '/api/chatgpt' && req.method === 'GET') return json(chatgpt.status())
      if (path.startsWith('/api/chatgpt/') && req.method === 'POST') {
        z.object({}).strict().parse(await body())
        if (path === '/api/chatgpt/connect' || path === '/api/chatgpt/disconnect') {
          if ([...conversations.values()].some((c) => ['queued', 'running'].includes(c.status) &&
            providers.find((p) => p.id === c.session.selection?.provider)?.protocol === 'chatgpt'))
            return json({ error: 'Wait for active ChatGPT turns before changing the connection.' }, 409)
          if (connectionChanging) return json({ error: 'ChatGPT connection update in progress' }, 409)
          connectionChanging = true
          resetModels()
          try { return json(path.endsWith('/connect') ? await chatgpt.start() : await chatgpt.disconnect()) }
          finally { connectionChanging = false }
        }
      }
      if (path === '/api/providers/models' && req.method === 'POST') {
        const { provider: id } = z.object({ provider: z.string().min(1).max(80) }).strict().parse(await body())
        const provider = providers.find((candidate) => candidate.id === id)
        if (!provider) return json({ error: 'Unknown provider' }, 404)
        try {
          if (provider.protocol === 'chatgpt') {
            if (!chatgpt.status().connected) return json({ error: 'Connect ChatGPT first' }, 409)
            await refreshModels()
          } else {
            provider.models = await discoverModels(provider, env, options.agentOptions?.fetch)
            discoveries.set(provider.id, { status: 'ready' })
            provider.note = 'Model IDs loaded from the provider. Reasoning controls are shown only where their capabilities are known.'
          }
          return json({ providers: catalog(providers, env, chatgpt.status().connected, discoveries), defaults })
        } catch (error) {
          provider.models = []
          discoveries.set(provider.id, { status: 'error', error: 'Model catalog lookup failed. Check provider credentials and endpoint.' })
          // Provider payloads and parser errors are server-side diagnostics only.
          console.error('[Models] discovery failed for', provider.id, error instanceof Error ? error.name : 'unknown')
          return json({ error: 'Model discovery failed. This provider is unavailable.' }, 502)
        }
      }
      if (path === '/api/providers' && req.method === 'GET')
        return json({ providers: catalog(providers, env, chatgpt.status().connected, discoveries), defaults })
      if (path === '/api/logout' && req.method === 'POST')
        return json({ ok: true }, 200, { 'set-cookie': 'successor=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' })
      if (path === '/api/conversations') {
        if (req.method === 'GET') return json([...conversations.values()].map(summary).sort((a,b) => b.updated.localeCompare(a.updated)))
        if (req.method === 'POST') return json(summary(await create('New conversation')), 201)
      }
      if (path === '/api/events' && req.method === 'GET') {
        let controller: ReadableStreamDefaultController<Uint8Array> | undefined
        const response = new ReadableStream<Uint8Array>({
          start(value) {
            controller = value
            subscribers.add(value)
            value.enqueue(encoder.encode(`event: snapshot\ndata: ${JSON.stringify({ streams: Object.fromEntries(liveText) })}\n\n`))
          },
          cancel() { if (controller) subscribers.delete(controller) },
        })
        // Detach on transport cancellation. Closing an already-aborted Bun stream
        // can surface as ERR_INCOMPLETE_CHUNKED_ENCODING in browsers.
        req.signal.addEventListener('abort', () => { if (controller) subscribers.delete(controller) }, { once: true })
        return new Response(response, { headers: {
          ...headers, 'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no',
        } })
      }
      const match = /^\/api\/conversations\/([^/]+)(\/turn)?$/.exec(path)
      if (match && uuid.safeParse(match[1]).success) {
        const c = conversations.get(match[1]!)
        if (!c) return json({ error: 'Not found' }, 404)
        if (!match[2] && req.method === 'GET') return json({ ...summary(c), messages: transcript(c.session), diagnostics: (c.session.diagnostics ?? []).map(diagnosticSummary) })
        if (!match[2] && req.method === 'PATCH') {
          const data = z.object({
            title: z.string().trim().min(1).max(100).optional(),
            selection: Selection.optional(),
          }).strict().refine((v) => v.title !== undefined || v.selection !== undefined).parse(await body())
          if (data.selection) {
            if (['queued', 'running'].includes(c.status))
              return json({ error: 'Cannot change provider/model during an active turn' }, 409)
            try { validateSelection(data.selection, providers, env, discoveries) }
            catch { return json({ error: 'Provider unavailable or model, reasoning, or speed setting unsupported. Refresh capabilities and choose supported settings.' }, 400) }
            c.session.selection = data.selection
          }
          if (data.title !== undefined) c.title = data.title
          c.updated = new Date().toISOString()
          await persist(c)
          return json(summary(c))
        }
        if (match[2] && req.method === 'POST') {
          const data = z.union([
            z.object({ input: z.string().trim().min(1).max(32_000) }).strict(),
            z.object({ retry: z.literal(true) }).strict(),
          ]).parse(await body())
          if ('retry' in data && !['error', 'interrupted'].includes(c.status))
            return json({ error: 'No failed turn to retry' }, 409)
          if (!await enqueue(c, 'input' in data ? data.input : undefined))
            return json({ error: 'This conversation already has an active turn' }, 409)
          return json(summary(c), 202)
        }
      }
      return json({ error: 'Not found' }, 404)
    }
    const files: Record<string, [string, string]> = {
      '/': ['index.html', 'text/html; charset=utf-8'],
      '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
      '/markdown.js': ['markdown.js', 'text/javascript; charset=utf-8'],
      '/katex.css': ['katex.css', 'text/css; charset=utf-8'],
      '/style.css': ['style.css', 'text/css; charset=utf-8'],
      '/plan': ['plan.html', 'text/html; charset=utf-8'],
      '/plan.js': ['plan.js', 'text/javascript; charset=utf-8'],
      '/plan.css': ['plan.css', 'text/css; charset=utf-8'],
    }
    if (req.method === 'GET' && path.startsWith('/fonts/')) {
      const name = path.slice(7)
      if (/^[A-Za-z0-9_.-]+$/.test(name)) {
        const font = Bun.file(join(import.meta.dir, 'web', 'fonts', name))
        if (await font.exists()) return new Response(font, { headers: { ...headers, 'content-type': name.endsWith('.woff2') ? 'font/woff2' : name.endsWith('.woff') ? 'font/woff' : 'application/octet-stream' } })
      }
    }
    const file = files[path]
    if (req.method === 'GET' && file)
      return new Response(Bun.file(join(import.meta.dir, 'web', file[0])), { headers: { ...headers, 'content-type': file[1] } })
    return json({ error: 'Not found' }, 404)
  }
  return {
    fetch: async (req: Request) => {
      try { return await handler(req) }
      catch (error) { return json({ error: error instanceof DiagnosticError ? advice[error.category] : 'Request failed; check input or server storage' }, 400) }
    },
    drained: () => Promise.all([turnsDrained(), work.drained(), plan.drained()]),
    close: () => { closeStreams(); return chatgpt.close() },
  }
}

if (import.meta.main) {
  const directory = resolve(process.env.WEB_DATA_DIR ?? 'web-data')
  const token = await credential(directory)
  const app = await createApp({
    directory, token, apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL,
    seed: resolve(process.env.SESSION_FILE ?? 'session.json'),
  })
  const server = Bun.serve({
    hostname: '0.0.0.0', port: Number(process.env.WEB_PORT ?? 3000),
    maxRequestBodySize: 65_536, fetch: app.fetch,
  })
  console.log(`Successor web: ${server.url}\nAccess token: ${join(directory, 'access-token')} (keep private)\nOne server per data directory; start via bun run web for locking.`)
  const shutdown = async () => {
    console.log('Draining active turns before shutdown…')
    await server.stop()
    await app.drained()
    await app.close()
    process.exit(0)
  }
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
}
