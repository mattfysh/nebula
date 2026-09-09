import { DiagnosticError, ioError, httpError, type Phase } from './diagnostics.ts'
import { z } from 'zod'
import { ChatGPTAuth, ChatGPTError, boundedJson, type Fetch, type ChatGPTCredentials } from './chatgpt-auth.ts'
import { apiRequest, apiOutput } from './provider-api.ts'
import { Model, type Provider, type Selection } from './providers.ts'

const base = 'https://chatgpt.com/backend-api/codex'
function headers(auth: ChatGPTCredentials) {
  return {
    authorization: `Bearer ${auth.accessToken}`, 'ChatGPT-Account-Id': auth.accountId,
    ...(auth.residency ? { 'x-openai-internal-codex-residency': auth.residency } : {}),
    'user-agent': 'successor/1',
  }
}
// Terminal responses contain the authoritative complete output. Never execute
// tools from deltas, an incomplete response, a truncated stream or a failed turn.
export async function completedResponse(response: Response, maxBytes = 16 * 1024 * 1024) {
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream'))
    throw new DiagnosticError('response_validation')
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let bytes = 0, buffer = '', data: string[] = []
  const event = () => {
    if (!data.length) return undefined
    const text = data.join('\n'); data = []
    if (text === '[DONE]') throw new DiagnosticError('incomplete_response')
    const value = JSON.parse(text)
    if (['error', 'response.failed', 'response.incomplete'].includes(value.type)) throw new DiagnosticError('incomplete_response')
    if (value.type === 'response.completed') {
      if (value.response?.status !== 'completed') throw new DiagnosticError('response_validation')
      return value.response
    }
  }
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.length
      if (bytes > maxBytes) throw new DiagnosticError('stream_limit')
      buffer += decoder.decode(value, { stream: true })
      let index: number
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, '')
        buffer = buffer.slice(index + 1)
        if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
        else if (!line) {
          const completed = event()
          if (completed) return completed
        }
      }
    }
    throw new DiagnosticError('incomplete_response')
  } catch (e) { throw e instanceof SyntaxError ? new DiagnosticError('response_validation') : ioError(e) }
  finally { await reader.cancel().catch(() => {}) }
}
export async function chatgptOutput(options: {
  auth: ChatGPTAuth, provider: Provider, selection: Selection, messages: Record<string, unknown>[],
  instructions: string, fetch?: Fetch, timeoutMs: number, progress?: (phase: Phase) => Promise<void>,
}) {
  const auth = await options.auth.access()
  const provider = { ...options.provider, protocol: 'responses' as const }
  const request = apiRequest(provider, options.selection, options.messages, options.instructions)
  // Fixed endpoint: subscription tokens must never be sent to profile URLs or the API-key endpoint.
  await options.progress?.('request')
  let response: Response
  try {
    response = await (options.fetch ?? fetch)(`${base}/responses`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(options.timeoutMs),
      headers: { ...headers(auth), 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ ...request.body, stream: true }),
    })
  } catch (e) { throw ioError(e, options.timeoutMs) }
  if (!response.ok) {
    void response.body?.cancel().catch(() => {})
    if (response.status === 401) await options.auth.rejected(auth.accessToken)
    throw httpError(response)
  }
  await options.progress?.('response')
  const complete = await completedResponse(response)
  try { return apiOutput(provider, complete) }
  catch (e) { throw e instanceof DiagnosticError ? e : new DiagnosticError('response_validation') }
}

// Metadata is best-effort, not proof of entitlement. No inference request or paid
// fallback is made when discovery fails. The fallback catalog stays clearly labeled.
export async function chatgptModels(auth: ChatGPTAuth, request: Fetch = fetch) {
  const credential = await auth.access()
  const res = await request(`${base}/models?client_version=0.101.0`, {
    method: 'GET', redirect: 'error', signal: AbortSignal.timeout(30_000), headers: headers(credential),
  })
  if (!res.ok) {
    await res.body?.cancel()
    if (res.status === 401) await auth.rejected(credential.accessToken)
    throw new ChatGPTError('ChatGPT model discovery unavailable.')
  }
  const data = z.object({ models: z.array(z.object({
    slug: Model.shape.id, visibility: z.string().optional(),
    supported_reasoning_levels: z.array(z.object({ effort: z.string().min(1).max(40) })).optional(),
  })).max(2000) }).parse(await boundedJson(res))
  const models = data.models.filter((m) => m.visibility !== 'hide').map((m) => Model.parse({
    id: m.slug, reasoning: [...new Set((m.supported_reasoning_levels ?? []).map((r) => r.effort))].filter((r) => r !== 'default'),
  }))
  if (!models.length) throw new ChatGPTError('No ChatGPT model metadata returned.')
  return models
}
