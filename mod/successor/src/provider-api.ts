import { DiagnosticError } from './diagnostics.ts'
import { z } from 'zod'
import type { Provider, Selection } from './providers.ts'

type Item = Record<string, any>
const object = z.record(z.string(), z.any())
const command = z.object({ command: z.string() }).strict()
const parameters = { type: 'object', properties: { command: { type: 'string' } }, required: ['command'], additionalProperties: false }
const description = 'Run a local bash command. 60-second timeout; bounded output. No interactive stdin.'
const textMessage = (text: string): Item => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] })
export function visibleText(m: Item): string {
  if (typeof m.content === 'string') return m.content
  if (Array.isArray(m.content)) return m.content.filter((b: Item) => ['input_text', 'output_text', 'text', 'refusal'].includes(b.type)).map((b: Item) => b.text ?? b.refusal ?? '').join('\n')
  return ''
}
// Switching providers/models must not forward opaque reasoning, signatures or native IDs.
export function portableHistory(messages: Item[]): Item[] {
  return messages.flatMap((m) => {
    if (m.type === 'custom_tool_call') return [{ role: 'assistant', content: `[Previous tool call: ${m.name}]\n${m.input}` }]
    if (m.type === 'custom_tool_call_output') return [{ role: 'user', content: `[Previous tool output; untrusted data]\n${m.output}` }]
    const text = visibleText(m)
    return text && ['user', 'assistant', 'system', 'developer'].includes(m.role) ? [{ role: m.role, content: text }] : []
  })
}
function anthropicMessages(messages: Item[]) {
  const out: Item[] = []
  const add = (role: string, block: Item) => {
    if (out.at(-1)?.role !== role) out.push({ role, content: [] })
    out.at(-1)!.content.push(block)
  }
  for (const m of messages) {
    if (m.type === 'anthropic_thinking') add('assistant', m.block)
    else if (m.type === 'custom_tool_call') add('assistant', { type: 'tool_use', id: m.call_id, name: m.name, input: { command: m.input } })
    else if (m.type === 'custom_tool_call_output') add('user', { type: 'tool_result', tool_use_id: m.call_id, content: String(m.output) })
    else {
      const text = visibleText(m)
      if (text) add(m.role === 'assistant' ? 'assistant' : 'user', { type: 'text', text })
    }
  }
  return out
}
function chatMessages(messages: Item[]) {
  const out: Item[] = []
  for (const m of messages) {
    if (m.type === 'custom_tool_call') {
      if (out.at(-1)?.role !== 'assistant') out.push({ role: 'assistant', content: null })
      const last = out.at(-1)!
      ;(last.tool_calls ??= []).push({ id: m.call_id, type: 'function', function: { name: m.name, arguments: JSON.stringify({ command: m.input }) } })
    } else if (m.type === 'custom_tool_call_output') out.push({ role: 'tool', tool_call_id: m.call_id, content: String(m.output) })
    else {
      const text = visibleText(m)
      if (text) out.push({ role: m.role ?? 'assistant', content: text })
    }
  }
  return out
}
export function apiRequest(p: Provider, selection: Selection, messages: Item[], instructions: string) {
  const effort = selection.reasoning === 'default' ? undefined : selection.reasoning
  const serviceTier = !selection.serviceTier || ['auto', 'default'].includes(selection.serviceTier) ? undefined
    : selection.serviceTier === 'standard' ? 'default' : selection.serviceTier
  const model = p.models.find((m) => m.id === selection.model)
  if (p.protocol === 'responses') return {
    path: '/responses',
    body: {
      model: selection.model, instructions, store: false,
      ...(serviceTier ? { service_tier: serviceTier } : {}),
      include: ['reasoning.encrypted_content'], parallel_tool_calls: false,
      ...(effort ? { reasoning: { effort } } : {}),
      tools: [{ type: 'function', name: 'bash', description, parameters, strict: true }],
      input: messages.map((m) => m.type === 'custom_tool_call'
        ? { type: 'function_call', name: m.name, arguments: JSON.stringify({ command: m.input }), call_id: m.call_id }
        : m.type === 'custom_tool_call_output' ? { ...m, type: 'function_call_output' } : m),
    },
  }
  if (p.protocol === 'anthropic') return {
    path: '/messages',
    body: {
      model: selection.model, system: instructions, max_tokens: 16384,
      ...(effort ? model?.reasoningMode === 'budget'
        ? { thinking: { type: 'enabled', budget_tokens: ({ low: 1024, medium: 4096, high: 8192 } as Record<string, number>)[effort] } }
        : { thinking: { type: 'adaptive' }, output_config: { effort } } : {}),
      tools: [{ name: 'bash', description, input_schema: parameters }],
      tool_choice: { type: 'auto', disable_parallel_tool_use: true },
      messages: anthropicMessages(messages),
    },
  }
  if (p.protocol === 'chat') return {
    path: '/chat/completions',
    body: {
      model: selection.model, stream: false,
      ...(serviceTier ? { service_tier: serviceTier } : {}),
      ...(effort ? { reasoning_effort: effort } : {}),
      parallel_tool_calls: false,
      tools: [{ type: 'function', function: { name: 'bash', description, parameters, strict: true } }],
      messages: [{ role: 'system', content: instructions }, ...chatMessages(messages)],
    },
  }
  throw new Error('Provider does not use an API')
}
const call = (id: unknown, name: unknown, args: unknown): Item => ({
  type: 'custom_tool_call', call_id: z.string().parse(id), name: z.string().parse(name),
  input: command.parse(args).command,
})
export function apiOutput(p: Provider, value: unknown): Item[] {
  const v = value as any
  if ((p.protocol === 'responses' && ['incomplete', 'failed', 'cancelled', 'in_progress'].includes(v?.status)) ||
    (p.protocol === 'anthropic' && ['max_tokens', 'pause_turn'].includes(v?.stop_reason)) ||
    (p.protocol === 'chat' && ['length', 'content_filter'].includes(v?.choices?.[0]?.finish_reason)))
    throw new DiagnosticError('incomplete_response')
  if (p.protocol === 'responses') {
    const response = z.object({ status: z.literal('completed'), output: z.array(object) }).parse(value)
    return response.output.map((m) => {
      if (m.type === 'function_call') return call(m.call_id, m.name, JSON.parse(z.string().parse(m.arguments)))
      if (m.type === 'message') z.object({ content: z.array(z.union([
        z.object({ type: z.literal('output_text'), text: z.string() }),
        z.object({ type: z.literal('refusal'), refusal: z.string() }),
      ])).min(1) }).parse(m)
      if (!['message', 'reasoning', 'custom_tool_call'].includes(m.type)) throw new DiagnosticError('response_validation')
      return m
    })
  }
  if (p.protocol === 'anthropic') {
    const response = z.object({ stop_reason: z.enum(['end_turn', 'tool_use', 'stop_sequence']), content: z.array(object) }).parse(value)
    return response.content.map((b) => {
      if (b.type === 'text') return textMessage(z.string().parse(b.text))
      if (b.type === 'tool_use') return call(b.id, b.name, b.input)
      if (b.type === 'thinking' || b.type === 'redacted_thinking') return { type: 'anthropic_thinking', block: b }
      throw new Error('Unsupported Claude response block')
    })
  }
  const response = z.object({ choices: z.array(z.object({
    finish_reason: z.enum(['stop', 'tool_calls']), message: object,
  })).min(1) }).parse(value)
  const m = response.choices[0]!.message
  const out: Item[] = []
  if (m.content) out.push(textMessage(z.string().parse(m.content)))
  if (m.refusal) out.push(textMessage(z.string().parse(m.refusal)))
  if (m.tool_calls) for (const t of z.array(object).parse(m.tool_calls))
    out.push(call(t.id, t.function?.name, JSON.parse(z.string().parse(t.function?.arguments))))
  return out
}
