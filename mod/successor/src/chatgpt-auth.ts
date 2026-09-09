import { DiagnosticError, httpError, ioError } from './diagnostics.ts'
import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

// Public client identifier used by the Codex-compatible device flow (not a secret).
// Protocol references: OpenAI codex-rs/login/src/device_code_auth.rs and
// OpenCode src/plugin/openai/codex.ts. No executable or credential-file dependency.
export const CHATGPT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const issuer = 'https://auth.openai.com'
export const CHATGPT_DEVICE_URL = `${issuer}/codex/device`
export type Fetch = (url: string, init: RequestInit) => Promise<Response>
export class ChatGPTError extends DiagnosticError {
  constructor(message: string) { super('auth'); this.message = message }
}
const safe = (text: string) => new ChatGPTError(text)
const secret = z.string().min(1).max(32768).regex(/^[\x21-\x7e]+$/)
const header = z.string().min(1).max(256).regex(/^[\w.-]+$/)
const Credentials = z.object({
  version: z.literal(1), accessToken: secret, refreshToken: secret,
  accountId: header, residency: header.optional(), expiresAt: z.number().finite(),
})
export type ChatGPTCredentials = z.infer<typeof Credentials>
const Tokens = z.object({
  access_token: secret, refresh_token: secret.optional(), id_token: secret.optional(),
  expires_in: z.number().positive().optional(),
})

// Parse only tokens received from OpenAI over HTTPS, never browser-supplied JWTs.
// These claims select upstream account/residency; they do not authenticate web users.
function claims(token?: string): Record<string, any> {
  try { return JSON.parse(Buffer.from(token!.split('.')[1]!, 'base64url').toString()) ?? {} }
  catch { return {} }
}
function credentials(value: unknown, now: number, previous?: ChatGPTCredentials): ChatGPTCredentials {
  const t = Tokens.parse(value), id = claims(t.id_token), access = claims(t.access_token)
  const account = (c: Record<string, any>) => c.chatgpt_account_id ?? c['https://api.openai.com/auth']?.chatgpt_account_id ?? c.organizations?.[0]?.id
  const accountId = account(id) ?? account(access) ?? previous?.accountId
  if (previous && accountId !== previous.accountId) throw safe('ChatGPT account changed during refresh. Disconnect and reconnect.')
  const residency = access['https://api.openai.com/auth']?.chatgpt_compute_residency ?? access.chatgpt_compute_residency
  const expiresAt = Math.min(now + (t.expires_in ?? 3600) * 1000,
    typeof access.exp === 'number' ? access.exp * 1000 : Infinity)
  return Credentials.parse({
    version: 1, accessToken: t.access_token, refreshToken: t.refresh_token ?? previous?.refreshToken,
    accountId, residency: residency === 'no_constraint' ? undefined : residency, expiresAt,
  })
}
export async function boundedJson(response: Response, maxBytes = 1024 * 1024): Promise<unknown> {
  if (!response.body) throw new DiagnosticError('response_validation')
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.length
      if (bytes > maxBytes) throw new DiagnosticError('stream_limit')
      chunks.push(value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch (e) { throw e instanceof SyntaxError ? new DiagnosticError('response_validation') : ioError(e) }
  finally { await reader.cancel().catch(() => {}) }
}

type Pending = { deviceId: string, code: string, expiresAt: number, interval: number, nextPoll: number }
export class ChatGPTAuth {
  private tokens?: ChatGPTCredentials
  private pending?: Pending
  private error?: string
  private timer?: ReturnType<typeof setTimeout>
  private stopped = false
  private lastStart = -Infinity
  private queue: Promise<unknown> = Promise.resolve()
  private constructor(private directory: string, private options: { fetch?: Fetch, now?: () => number, automatic?: boolean }) {}
  static async open(directory: string, options: { fetch?: Fetch, now?: () => number, automatic?: boolean } = {}) {
    const auth = new ChatGPTAuth(directory, options)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    try { auth.tokens = Credentials.parse(JSON.parse(await readFile(auth.path, 'utf8'))) }
    catch (error: any) { if (error.code !== 'ENOENT') throw safe('Invalid ChatGPT credential storage. Check its private file; no credentials were logged.') }
    return auth
  }
  private get path() { return join(this.directory, 'chatgpt-auth.json') }
  private now() { return (this.options.now ?? Date.now)() }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.then(action)
    this.queue = next.catch(() => {})
    return next
  }
  private async store(tokens?: ChatGPTCredentials) {
    try {
    if (tokens) {
      // Remove an abandoned temporary file first so its old mode cannot be reused.
      await rm(this.path + '.tmp', { force: true })
      await writeFile(this.path + '.tmp', JSON.stringify(tokens) + '\n', { mode: 0o600, flag: 'wx' })
      await rename(this.path + '.tmp', this.path)
    } else {
      await rm(this.path, { force: true })
      await rm(this.path + '.tmp', { force: true })
    }
    this.tokens = tokens
    } catch { throw new DiagnosticError('storage') }
  }
  private async request(path: string, data: Record<string, string>, form = false) {
    try { return await (this.options.fetch ?? fetch)(issuer + path, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json', 'user-agent': 'successor/1' },
      body: form ? new URLSearchParams(data).toString() : JSON.stringify(data),
    }) } catch (e) { throw ioError(e, 30_000) }
  }
  status() {
    if (this.pending && this.now() >= this.pending.expiresAt) {
      this.pending = undefined
      this.error = 'ChatGPT login expired. Connect again.'
      clearTimeout(this.timer)
    }
    return {
      connected: !!this.tokens,
      account: this.tokens ? `…${this.tokens.accountId.slice(-8)}` : undefined,
      pending: this.pending ? { code: this.pending.code, url: CHATGPT_DEVICE_URL, expiresAt: this.pending.expiresAt } : undefined,
      error: this.error,
    }
  }
  private schedule() {
    clearTimeout(this.timer)
    if (this.options.automatic === false || this.stopped || !this.pending) return
    this.timer = setTimeout(() => { void this.poll().catch(() => {}) }, Math.max(1, this.pending.nextPoll - this.now()))
    this.timer.unref()
  }
  start() {
    return this.serial(async () => {
      if (this.stopped) throw safe('ChatGPT connection service is stopping.')
      if (this.status().connected) throw safe('Disconnect ChatGPT before connecting another account.')
      if (this.pending) return this.status()
      if (this.now() - this.lastStart < 30_000) throw safe('Wait 30 seconds before starting another ChatGPT login.')
      this.lastStart = this.now()
      this.error = undefined
      try {
        const res = await this.request('/api/accounts/deviceauth/usercode', { client_id: CHATGPT_CLIENT_ID })
        if (!res.ok) { await res.body?.cancel(); throw safe(`ChatGPT device login unavailable (HTTP ${res.status}). Check your account's device-code login setting.`) }
        const data = z.object({ device_auth_id: secret, user_code: z.string().min(1).max(64), interval: z.union([z.string(), z.number()]).optional() }).parse(await boundedJson(res))
        const interval = Math.min(60, Math.max(1, Number(data.interval) || 5)) * 1000 + 1000
        this.pending = { deviceId: data.device_auth_id, code: data.user_code, expiresAt: this.now() + 900_000, interval, nextPoll: this.now() + interval }
        this.schedule()
        return this.status()
      } catch (e) {
        this.error = e instanceof ChatGPTError ? e.message : 'Unable to start ChatGPT login. Check connectivity and try again.'
        throw safe(this.error)
      }
    })
  }
  poll() {
    return this.serial(async () => {
      this.status()
      const p = this.pending
      if (!p || this.stopped || this.now() < p.nextPoll) return this.status()
      p.nextPoll = this.now() + p.interval
      try {
        const res = await this.request('/api/accounts/deviceauth/token', { device_auth_id: p.deviceId, user_code: p.code })
        if (res.status === 403 || res.status === 404 || res.status === 429) {
          await res.body?.cancel()
          if (res.status === 429) p.interval = Math.min(60_000, p.interval + 5000)
          p.nextPoll = this.now() + p.interval
          return this.status()
        }
        if (!res.ok) { await res.body?.cancel(); throw safe('ChatGPT authorization failed. Connect again.') }
        const code = z.object({ authorization_code: secret, code_verifier: secret }).parse(await boundedJson(res))
        const token = await this.request('/oauth/token', {
          grant_type: 'authorization_code', code: code.authorization_code, code_verifier: code.code_verifier,
          redirect_uri: `${issuer}/deviceauth/callback`, client_id: CHATGPT_CLIENT_ID,
        }, true)
        if (!token.ok) { await token.body?.cancel(); throw safe('ChatGPT token exchange failed. Connect again.') }
        const tokens = credentials(await boundedJson(token), this.now())
        // A read-only status check may expire this attempt while HTTP is in flight.
        if (this.pending !== p || this.now() >= p.expiresAt) throw safe('ChatGPT login expired. Connect again.')
        await this.store(tokens)
        this.pending = undefined
        this.error = undefined
      } catch (e) {
        this.pending = undefined
        this.error = e instanceof ChatGPTError ? e.message : 'ChatGPT login failed or was interrupted. Connect again.'
      } finally { this.schedule() }
      return this.status()
    })
  }
  access() {
    return this.serial(async (): Promise<ChatGPTCredentials> => {
      if (!this.tokens) throw safe('Connect ChatGPT before sending a subscription turn.')
      if (this.tokens.expiresAt > this.now() + 60_000) return { ...this.tokens }
      try {
        const res = await this.request('/oauth/token', {
          grant_type: 'refresh_token', refresh_token: this.tokens.refreshToken, client_id: CHATGPT_CLIENT_ID,
        }, true)
        if (!res.ok) {
          await res.body?.cancel()
          if (res.status === 400 || res.status === 401 || res.status === 403) {
            await this.store(undefined)
            this.error = 'ChatGPT session expired or was revoked. Connect again.'
          }
          throw httpError(res)
        }
        const value = await boundedJson(res)
        let next: ChatGPTCredentials
        try { next = credentials(value, this.now(), this.tokens) }
        catch (e) { throw e instanceof DiagnosticError ? e : new DiagnosticError('response_validation') }
        await this.store(next)
        return { ...next }
      } catch (e) { throw e instanceof DiagnosticError ? e : new DiagnosticError('unknown') }
    })
  }
  // Called only for the credential that received a 401; a newer login must survive.
  rejected(accessToken: string) {
    return this.serial(async () => {
      if (this.tokens?.accessToken !== accessToken) return
      await this.store(undefined)
      this.error = 'ChatGPT rejected this session. Connect again.'
    })
  }
  disconnect() {
    return this.serial(async () => {
      clearTimeout(this.timer)
      this.pending = undefined
      await this.store(undefined)
      this.error = undefined
      return this.status()
    })
  }
  async close() {
    this.stopped = true
    clearTimeout(this.timer)
    await this.queue
  }
}
