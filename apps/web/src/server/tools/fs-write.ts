import { pendingWrites, readWorkspaceFileIfExists } from '@/server/pending-writes'
import { resolveWorkspacePath, writeWorkspaceFile } from '@/server/workspace-service'

import type { ToolDef } from './types'
import { asRecord, readString } from './utils'

export const fsWriteTool: ToolDef = {
  name: 'fs_write',
  description: 'Write a UTF-8 text file inside the current workspace.',
  parameters: {
    type: 'object',
    required: ['path', 'content'],
    properties: {
      path: { type: 'string', description: 'File path relative to workspace root.' },
      content: { type: 'string', description: 'Full file content to write.' },
    },
  },
  async handler(args, ctx) {
    const input = asRecord(args)
    const filePath = readString(input.path)
    const content = readString(input.content)
    if (!filePath) return { ok: false, error: 'path is required' }
    if (content === null) return { ok: false, error: 'content is required' }

    if (ctx.conversation.fsWriteApprovalMode === 'review') {
      let absolutePath: string
      try {
        absolutePath = resolveWorkspacePath(ctx.conversation, filePath)
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }

      const pending = pendingWrites.register({
        conversation: ctx.conversation,
        agentId: ctx.agentId,
        runId: ctx.runId,
        path: filePath,
        absolutePath,
        oldContent: readWorkspaceFileIfExists(ctx.conversation, filePath),
        newContent: content,
      })

      const decision = await new Promise<{ applied: boolean; result?: unknown; error?: string }>((resolve) => {
        pendingWrites.attachResolver(pending.id, resolve)
      })
      if (!decision.applied) return { ok: false, error: decision.error ?? 'User rejected the file change' }
      return { ok: true, value: decision.result }
    }

    return { ok: true, value: writeWorkspaceFile(ctx.conversation, filePath, content) }
  },
}
