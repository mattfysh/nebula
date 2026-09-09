import { z } from 'zod'

// Deliberately no free-form exception text, URLs, headers, bodies, stacks or IDs
// supplied by upstreams. Even request IDs can contain secrets on custom servers.
export const Category = z.enum(['unknown', 'configuration', 'auth', 'rate_limit', 'http', 'timeout', 'network',
  'response_validation', 'incomplete_response', 'stream_limit', 'tool_step_limit', 'storage', 'interruption', 'cli_exit', 'cli_start'])
export type Category = z.infer<typeof Category>
export const Phase = z.enum(['queued', 'starting', 'authentication', 'request', 'response', 'cli', 'tool', 'checkpoint', 'complete'])
export type Phase = z.infer<typeof Phase>
const Metadata = z.object({
  httpStatus: z.number().int().min(100).max(599).optional(),
  network: z.enum(['dns', 'connection', 'tls', 'unknown']).optional(),
  timeoutMs: z.number().nonnegative().finite().optional(),
  exitCode: z.number().int().optional(),
  providerCode: z.enum(['invalid_api_key', 'authentication_error', 'rate_limit_exceeded', 'insufficient_quota', 'overloaded_error', 'invalid_request_error']).optional(),
})
export type Metadata = z.infer<typeof Metadata>
const safeName = z.string().max(120).regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/)
export const Attempt = z.object({
  id: z.string().uuid(), turnId: z.string().uuid(), retryOf: z.string().uuid().optional(),
  timestamp: z.string().datetime(), startedAt: z.string().datetime().optional(), endedAt: z.string().datetime().optional(),
  provider: safeName, model: safeName, reasoning: safeName,
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'interrupted']), phase: Phase,
  elapsedMs: z.number().nonnegative(), round: z.number().int().nonnegative(), toolsCompleted: z.number().int().nonnegative(),
  checkpointAt: z.string().datetime().optional(), checkpointItems: z.number().int().nonnegative().optional(),
  category: Category.optional(), metadata: Metadata.optional(), storageFailed: z.boolean().optional(), timingUnknown: z.boolean().optional(),
})
export type Attempt = z.infer<typeof Attempt>
export const RETAIN_ATTEMPTS = 50
export const Attempts = z.array(Attempt).max(RETAIN_ATTEMPTS)
type History = { diagnostics?: Attempt[] }
const name = (value?: string) => safeName.safeParse(value).success ? value! : 'unknown'
export function beginAttempt(history: History, selection?: { provider: string, model: string, reasoning: string }, retry = false) {
  const list = history.diagnostics ??= [], previous = retry ? list.at(-1) : undefined
  const attempt: Attempt = {
    id: crypto.randomUUID(), turnId: previous?.turnId ?? crypto.randomUUID(),
    ...(previous ? { retryOf: previous.id } : {}), timestamp: new Date().toISOString(),
    provider: name(selection?.provider), model: name(selection?.model), reasoning: name(selection?.reasoning),
    status: 'queued', phase: 'queued', elapsedMs: 0, round: 0, toolsCompleted: 0,
  }
  list.push(attempt)
  list.splice(0, Math.max(0, list.length - RETAIN_ATTEMPTS))
  return attempt
}
export const advice: Record<Category, string> = {
  unknown: 'Unknown failure. Review the last checkpoint and provider setup before Retry; the cause was not retained.',
  configuration: 'Provider configuration unavailable. Check the selected provider, model and reasoning settings.',
  auth: 'Authentication rejected or unavailable. Check the API key or reconnect the selected subscription.',
  rate_limit: 'Provider rate limit or quota reached. Check quota and wait before manually retrying.',
  http: 'Provider HTTP request failed. Check provider availability and model access before Retry.',
  timeout: 'Request timed out. Check connectivity and provider availability before Retry.',
  network: 'Network request failed. Check DNS, connectivity and TLS configuration before Retry.',
  response_validation: 'Invalid provider response. Check provider compatibility before Retry; review saved tool effects before continuing.',
  incomplete_response: 'Incomplete provider response. Check provider availability and output limits before Retry; partial tool calls were not executed.',
  stream_limit: 'Response stream exceeded the safety limit. Review history and reduce the requested output before Retry.',
  tool_step_limit: 'Tool-step limit reached. Retry to continue after reviewing saved tool results.',
  storage: 'Checkpoint/storage failed. Check disk space and private directory permissions; inspect command effects before Retry.',
  interruption: 'Server/process stopped during this attempt. Inspect saved history and command effects before Retry.',
  cli_exit: 'CLI exited unsuccessfully. Check the selected CLI login/configuration; inspect command effects before Retry.',
  cli_start: 'CLI could not start. Check that the selected executable is installed and accessible.',
}
export class DiagnosticError extends Error {
  readonly metadata: Metadata
  constructor(readonly category: Category, metadata: Metadata = {}) {
    const clean = Metadata.parse(metadata)
    super(advice[category] + (clean.httpStatus ? ` (HTTP ${clean.httpStatus})` : ''))
    this.name = 'DiagnosticError'
    this.metadata = clean
  }
}
// Classify at I/O boundaries, never by arbitrary exception message matching.
export function ioError(error: unknown, timeoutMs?: number): DiagnosticError {
  if (error instanceof DiagnosticError) return error
  const e = error as { name?: unknown, code?: unknown, cause?: { code?: unknown } } | null
  const code = e?.code ?? e?.cause?.code
  if (e?.name === 'TimeoutError' || code === 'ETIMEDOUT') return new DiagnosticError('timeout', { timeoutMs })
  if (e?.name === 'AbortError') return new DiagnosticError('interruption')
  const network = ['ENOTFOUND', 'EAI_AGAIN'].includes(String(code)) ? 'dns'
    : ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH'].includes(String(code)) ? 'connection'
    : ['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID'].includes(String(code)) ? 'tls' : undefined
  return network ? new DiagnosticError('network', { network }) : new DiagnosticError('unknown')
}
export function httpError(response: Response) {
  return new DiagnosticError([401, 403].includes(response.status) ? 'auth' : response.status === 429 ? 'rate_limit' : 'http', { httpStatus: response.status })
}
export function failure(error: unknown) { return error instanceof DiagnosticError ? error : new DiagnosticError('unknown') }
export function finishAttempt(a: Attempt, error?: unknown) {
  a.endedAt = new Date().toISOString()
  a.elapsedMs = Math.max(0, Date.now() - Date.parse(a.timestamp))
  if (error !== undefined) {
    const e = failure(error)
    a.status = e.category === 'interruption' ? 'interrupted' : 'failed'
    a.category = e.category; a.metadata = e.metadata
  } else { a.status = 'succeeded'; a.phase = 'complete' }
}
export function recoverAttempts(history: History) {
  for (const a of history.diagnostics ?? []) if (['queued', 'running'].includes(a.status)) finishAttempt(a, new DiagnosticError('interruption'))
}
export function diagnosticSummary(a: Attempt) {
  // Schema projection is also used at the browser/export boundary.
  const clean = Attempt.parse(a)
  return { ...clean, description: clean.category ? advice[clean.category] : undefined }
}

export function cliEventError(value: unknown) {
  const e = value as { code?: unknown, status?: unknown } | null
  const parsed = Metadata.shape.providerCode.safeParse(e?.code)
  const code = parsed.success ? parsed.data : undefined
  const status = Metadata.shape.httpStatus.safeParse(e?.status)
  const category = code === 'invalid_api_key' || code === 'authentication_error' ? 'auth'
    : code === 'rate_limit_exceeded' || code === 'insufficient_quota' ? 'rate_limit'
    : status.success && status.data ? ([401, 403].includes(status.data) ? 'auth' : status.data === 429 ? 'rate_limit' : 'http') : 'unknown'
  return new DiagnosticError(category, { providerCode: code, httpStatus: status.success ? status.data : undefined })
}
