import { listWorkspaceDirectory } from '@/server/workspace-service'

import type { ToolDef } from './types'
import { asRecord, readString } from './utils'

export const fsListTool: ToolDef = {
  name: 'fs_list',
  description: 'List files and directories inside the current workspace.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory path relative to workspace root.' },
    },
  },
  async handler(args, ctx) {
    const input = asRecord(args)
    return { ok: true, value: listWorkspaceDirectory(ctx.conversation, readString(input.path) ?? '') }
  },
}
