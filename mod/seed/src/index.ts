import { z } from 'zod'
import { $ } from 'bun'

const { OPENAI_API_KEY } = process.env

const ResponseSchema = z.object({
  output: z.array(z.unknown()),
})

const ToolCallSchema = z.object({
  type: z.literal('custom_tool_call'),
  name: z.string(),
  input: z.string(),
  call_id: z.string(),
})

const MessageSchema = z.object({
  type: z.literal('message'),
  content: z.array(
    z.discriminatedUnion('type', [
      z.object({
        type: z.literal('output_text'),
        text: z.string(),
      }),
      z.object({
        type: z.literal('refusal'),
        refusal: z.string(),
      }),
    ]),
  ),
})

const OutputSchema = z.union([ToolCallSchema, MessageSchema])

const messages: any[] = []
let ptr = 0

async function openai() {
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-6-astra',
      store: false,
      tools: [
        {
          type: 'custom',
          name: 'bash',
        },
      ],
      input: messages,
    }),
  })

  if (!res.ok) {
    console.error(await res.text())
    throw new Error(`Response from openai not ok: ${res.status}`)
  }

  const json = await res.json()
  // console.log(JSON.stringify(json, null, 2))
  return ResponseSchema.parse(json)
}

async function call(tool: z.infer<typeof ToolCallSchema>) {
  if (tool.name !== 'bash') {
    throw new Error(`Unknown custom_tool_call.name: ${tool.name}`)
  }
  const result = await $`bash -c ${tool.input} 2>&1`.nothrow().quiet()
  const output = `${result.text()}\n\nexit code: ${result.exitCode ?? 'null'}`
  messages.push({ type: 'custom_tool_call_output', call_id: tool.call_id, output })
}

async function* turn(input: string) {
  messages.push({ role: 'user', content: input })

  while (ptr !== messages.length) {
    const { output } = await openai()
    messages.push(...output)
    ptr = messages.length
    for (const out of output) {
      const { data } = OutputSchema.safeParse(out)
      if (data?.type === 'message') {
        for (const block of data.content) {
          yield block.type === 'output_text' ? block.text : block.refusal
        }
      } else if (data?.type === 'custom_tool_call') {
        await call(data)
      }
    }
  }
}

while (true) {
  const input = prompt('> ')
  if (!input) {
    break
  }
  for await (const output of turn(input)) {
    console.log(output)
  }
}
