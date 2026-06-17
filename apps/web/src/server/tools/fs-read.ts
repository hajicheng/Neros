import { readWorkspaceFile } from '@/server/workspace-service'

import type { ToolDef } from './types'
import { asRecord, readString } from './utils'

export const fsReadTool: ToolDef = {
  name: 'fs_read',
  description: 'Read a UTF-8 text file from the current workspace.',
  parameters: {
    type: 'object',
    required: ['path'],
    properties: {
      path: { type: 'string', description: 'File path relative to workspace root.' },
    },
  },
  async handler(args, ctx) {
    const input = asRecord(args)
    const filePath = readString(input.path)
    if (!filePath) return { ok: false, error: 'path is required' }
    return { ok: true, value: readWorkspaceFile(ctx.conversation, filePath) }
  },
}
