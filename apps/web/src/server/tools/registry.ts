import { bashTool } from './bash'
import { fsListTool } from './fs-list'
import { fsReadTool } from './fs-read'
import { fsWriteTool } from './fs-write'
import { createUnavailableTool } from './unavailable'
import type { ToolContext, ToolDef, ToolResult } from './types'
import { writeArtifactTool } from './write-artifact'

class ToolRegistry {
  private tools = new Map<string, ToolDef>()

  register(tool: ToolDef): void {
    if (this.tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`)
    this.tools.set(tool.name, tool)
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name)
  }

  resolve(names: string[]): ToolDef[] {
    const resolved: ToolDef[] = []
    for (const name of names) {
      const tool = this.tools.get(name)
      if (!tool) throw new Error(`Unknown tool: ${name}`)
      resolved.push(tool)
    }
    return resolved
  }

  async execute(toolName: string, args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(toolName)
    if (!tool) return { ok: false, error: `Unknown tool: ${toolName}` }
    try {
      return await tool.handler(args, ctx)
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
}

function buildRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register(writeArtifactTool)
  registry.register(createUnavailableTool('read_artifact', 'Read an existing artifact.'))
  registry.register(createUnavailableTool('deploy_artifact', 'Deploy a web artifact.'))
  registry.register(createUnavailableTool('deploy_workspace', 'Deploy a static workspace directory.'))
  registry.register(createUnavailableTool('read_attachment', 'Read an uploaded attachment.'))
  registry.register(createUnavailableTool('ask_user', 'Ask the user a structured question.'))
  registry.register(fsListTool)
  registry.register(fsReadTool)
  registry.register(fsWriteTool)
  registry.register(bashTool)
  return registry
}

export const toolRegistry = buildRegistry()

export type { ToolContext, ToolDef, ToolResult } from './types'
