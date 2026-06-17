import type { ToolDef } from './types'

export function createUnavailableTool(name: string, description: string): ToolDef {
  return {
    name,
    description,
    parameters: {
      type: 'object',
      properties: {},
    },
    async handler() {
      return {
        ok: false,
        error: `${name} is registered but not implemented in Neros yet.`,
      }
    },
  }
}
