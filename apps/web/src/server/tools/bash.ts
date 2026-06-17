import { runWorkspaceCommand } from '@/server/workspace-service'
import { pendingBashCommands } from '@/server/pending-bash-commands'

import type { ToolDef } from './types'
import { asRecord, readString } from './utils'

export const bashTool: ToolDef = {
  name: 'bash',
  description: 'Run a shell command in the current workspace.',
  parameters: {
    type: 'object',
    required: ['command'],
    properties: {
      command: { type: 'string', description: 'Command to run.' },
      cwd: { type: 'string', description: 'Optional cwd relative to workspace root.' },
      reason: { type: 'string', description: 'Why this command needs to be run.' },
      timeoutMs: { type: 'number', description: 'Optional timeout in milliseconds.' },
    },
  },
  async handler(args, ctx) {
    const input = asRecord(args)
    const command = readString(input.command)
    if (!command) return { ok: false, error: 'command is required' }
    const cwd = readString(input.cwd) ?? ''
    const reason = readString(input.reason) ?? 'Agent requested command execution'
    const timeoutMs = typeof input.timeoutMs === 'number' ? input.timeoutMs : undefined

    const pending = pendingBashCommands.register({
      conversationId: ctx.conversation.id,
      agentId: ctx.agentId,
      runId: ctx.runId,
      command,
      cwd,
      reason,
    })
    const decision = await new Promise<{ approved: boolean }>((resolve) => {
      pendingBashCommands.attachResolver(pending.id, resolve)
    })
    if (!decision.approved) return { ok: false, error: 'User rejected the command' }

    return { ok: true, value: await runWorkspaceCommand(ctx.conversation, command, cwd, timeoutMs) }
  },
}
