import { z } from 'zod'
import type { Provider, Selection } from './providers.ts'

export const UsageRecord = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  reasoningTokens: z.number().int().nonnegative().optional(),
  cacheReadTokens: z.number().int().nonnegative().optional(),
  cacheWriteTokens: z.number().int().nonnegative().optional(),
  estimatedCostUsd: z.number().nonnegative().optional(),
  timestamp: z.string(),
})
export type UsageRecord = z.infer<typeof UsageRecord>

export function usageFromResponse(value: unknown, provider: Provider, selection: Selection): UsageRecord | undefined {
  const u: any = (value as any)?.usage
  if (!u || typeof u !== 'object') return undefined
  const number = (...keys: string[]) => {
    const value = keys.map((k) => u[k]).find((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0)
    return value === undefined ? undefined : Math.floor(value)
  }
  const inputTokens = number('input_tokens', 'prompt_tokens')
  const outputTokens = number('output_tokens', 'completion_tokens')
  const reasoningTokens = number('reasoning_tokens') ?? (typeof u.completion_tokens_details?.reasoning_tokens === 'number' ? u.completion_tokens_details.reasoning_tokens : undefined)
  const cacheReadTokens = number('cache_read_input_tokens') ?? (typeof u.prompt_tokens_details?.cached_tokens === 'number' ? u.prompt_tokens_details.cached_tokens : undefined)
  const cacheWriteTokens = number('cache_creation_input_tokens')
  if ([inputTokens, outputTokens, reasoningTokens, cacheReadTokens, cacheWriteTokens].every((n) => n === undefined)) return undefined
  return { inputTokens, outputTokens, reasoningTokens, cacheReadTokens, cacheWriteTokens, timestamp: new Date().toISOString() }
}
export function usageSummary(records: UsageRecord[] | undefined, provider: Provider | undefined) {
  const all = records ?? []
  const sum = (key: keyof UsageRecord) => all.reduce((n, r) => n + (typeof r[key] === 'number' ? r[key] as number : 0), 0)
  const reported = all.length > 0
  const estimated = all.some((r) => r.estimatedCostUsd !== undefined)
  return {
    inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), reasoningTokens: sum('reasoningTokens'),
    cacheReadTokens: sum('cacheReadTokens'), cacheWriteTokens: sum('cacheWriteTokens'), requests: all.length,
    reported, pricing: provider?.protocol === 'chatgpt' || provider?.protocol === 'codex' ? 'n/a (subscription)' : estimated ? 'estimated' : 'unavailable',
    estimatedCostUsd: estimated ? sum('estimatedCostUsd') : undefined,
  }
}
