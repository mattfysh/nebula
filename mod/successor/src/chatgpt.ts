import { DiagnosticError, ioError, httpError, type Phase } from './diagnostics.ts'
import { z } from 'zod'
import { ChatGPTAuth, ChatGPTError, boundedJson, type Fetch, type ChatGPTCredentials } from './chatgpt-auth.ts'
import { apiRequest, apiOutput } from './provider-api.ts'
import { usageFromResponse } from './usage.ts'
import { Model, type Provider, type Selection } from './providers.ts'

const base = 'https://chatgpt.com/backend-api/codex'
const modelsBase = 'https://chatgpt.com/backend-api/codex'
const codexClientVersion = '0.162.1'
function headers(auth: ChatGPTCredentials) {
  return {
    authorization: `Bearer ${auth.accessToken}`, 'ChatGPT-Account-Id': auth.accountId,
    ...(auth.residency ? { 'x-openai-internal-codex-residency': auth.residency } : {}),
    'user-agent': 'successor/1',
  }
}
// Terminal responses contain the authoritative complete output. Never execute
// tools from deltas, an incomplete response, a truncated stream or a failed turn.
export async function completedResponse(response: Response, maxBytes = 16 * 1024 * 1024, emit?: (text: string) => void) {
  if (!response.body)
    throw new DiagnosticError('response_validation')
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let bytes = 0, buffer = "", data: string[] = [], completedItems: unknown[] = []
  const event = () => {
    if (!data.length) return undefined
    const text = data.join('\n'); data = []
    if (text === '[DONE]') throw new DiagnosticError('incomplete_response')
    const value = JSON.parse(text)
    if (['error', 'response.failed', 'response.incomplete'].includes(value.type)) throw new DiagnosticError('incomplete_response')
    if (value.type === 'response.output_text.delta' && typeof value.delta === 'string') emit?.(value.delta)
    if (value.type === "response.output_item.done" && value.item?.status === "completed") completedItems.push(value.item)
    if (value.type === 'response.completed') {
      if (value.response?.status !== "completed") throw new DiagnosticError("response_validation")
      return { ...value.response, output: completedItems.length ? completedItems : value.response.output }
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
  emit?: (text: string) => void,
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
    let detail = ''; try { detail = (await response.text()).slice(0, 4096) } catch {}
    console.error('[ChatGPT] request failed: HTTP', response.status, detail)
    if (response.status === 401) await options.auth.rejected(auth.accessToken)
    throw httpError(response, detail)
  }
  await options.progress?.('response')
  const complete = await completedResponse(response, undefined, options.emit)
  try {
    const output = apiOutput(provider, complete) as ReturnType<typeof apiOutput> & { usage?: ReturnType<typeof usageFromResponse> }
    const usage = usageFromResponse(complete, options.provider, options.selection)
    if (usage) output.usage = usage
    return output
  } catch (e) { throw e instanceof DiagnosticError ? e : new DiagnosticError('response_validation') }
}

// Metadata is best-effort, not proof of entitlement. No inference request or paid
// fallback is made when discovery fails; the provider remains unavailable.
export async function chatgptModels(auth: ChatGPTAuth, request: Fetch = fetch) {
  const credential = await auth.access()
  const res = await request(`${modelsBase}/models?client_version=${codexClientVersion}`, {
    method: 'GET', redirect: 'error', signal: AbortSignal.timeout(30_000), headers: headers(credential),
  })
  if (!res.ok) {
    // Do not cancel before attempting to inspect a response: a consumed body
    // makes response.text() reject, which is why a log after cancel is invisible.
    // Upstream bodies are intentionally not logged; the status is safe and is
    // included in the diagnostic shown to the caller.
    if (res.status === 401) await auth.rejected(credential.accessToken)
    throw new ChatGPTError(`ChatGPT model discovery unavailable (HTTP ${res.status}).`)
  }
  // The account's catalog is authoritative. Keep this parser permissive because
  // OpenAI adds model metadata fields (and has changed reasoning-level shape).
  const data = z.object({
    models: z.array(z.object({
      slug: Model.shape.id,
      visibility: z.string().optional(),
      title: z.string().optional(),
      thinking_efforts: z.array(z.union([z.string(), z.object({ thinking_effort: z.string() }).passthrough()])).optional(),
      service_tiers: z.array(z.object({ id: z.string(), name: z.string(), description: z.string().optional() }).passthrough()).optional(),
      additional_speed_tiers: z.array(z.string()).optional(),
      supported_reasoning_levels: z.array(z.union([
        z.string(), z.object({ effort: z.string() }).passthrough(),
      ])).optional(),
    }).passthrough()).max(2000),
  }).parse(await boundedJson(res))
  // This is the Codex catalog; visible slugs are request model IDs.
  const unique = new Map<string, z.infer<typeof Model>>()
  for (const m of data.models) {
    if (m.visibility === 'hide') continue
    const id = m.slug
    const reasoning = [...new Set([
      ...(m.supported_reasoning_levels ?? []).map((r) => typeof r === 'string' ? r : r.effort),
      ...(m.thinking_efforts ?? []).map((r) => typeof r === 'string' ? r : r.thinking_effort),
    ])].filter((r) => r !== 'default')
    const serviceTiers = [...(m.service_tiers ?? [])]
    // Older catalogs advertised only a string speed tier. Preserve its exact
    // request ID; never infer account entitlement to another tier.
    if (!serviceTiers.length) for (const id of m.additional_speed_tiers ?? [])
      serviceTiers.push({ id, name: id === 'fast' ? 'Fast' : id })
    unique.set(id, Model.parse({ id, ...(m.title ? { label: m.title } : {}), reasoning, serviceTiers }))
  }
  const models = [...unique.values()]
  if (!models.length) throw new ChatGPTError('No Codex-compatible ChatGPT model metadata returned.')
  return models
}
