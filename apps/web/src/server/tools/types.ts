import type { ConversationWithMeta } from '@/db/schema'

export type ToolContext = {
  conversation: ConversationWithMeta
  agentId: string
  runId: string
}

export type ToolResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string }

export type ToolDef = {
  name: string
  description: string
  parameters: Record<string, unknown>
  handler: (args: unknown, ctx: ToolContext) => Promise<ToolResult>
}
