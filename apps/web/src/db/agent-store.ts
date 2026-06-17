import { sqlite } from './client'
import type { AgentRow } from './schema'

type AgentDbRow = {
  id: string
  name: string
  avatar: string
  description: string
  capabilities: string
  system_prompt: string
  adapter_name: string
  model_provider: string | null
  model_id: string | null
  api_key: string | null
  api_base_url: string | null
  tool_names: string
  is_builtin: number
  is_orchestrator: number
  supports_vision: number
  created_at: number
}

export function loadAgents(): AgentRow[] {
  const rows = sqlite
    .prepare(
      `SELECT
        id, name, avatar, description, capabilities, system_prompt,
        adapter_name, model_provider, model_id, api_key, api_base_url,
        tool_names, is_builtin, is_orchestrator, supports_vision, created_at
      FROM agents`,
    )
    .all() as AgentDbRow[]

  return sortAgents(rows.map(fromDbRow))
}

export function saveAgents(agents: readonly AgentRow[]): void {
  const ids = new Set(agents.map((agent) => agent.id))
  const upsert = sqlite.prepare(`
    INSERT INTO agents (
      id, name, avatar, description, capabilities, system_prompt,
      adapter_name, model_provider, model_id, api_key, api_base_url,
      tool_names, is_builtin, is_orchestrator, supports_vision, created_at
    ) VALUES (
      @id, @name, @avatar, @description, @capabilities, @system_prompt,
      @adapter_name, @model_provider, @model_id, @api_key, @api_base_url,
      @tool_names, @is_builtin, @is_orchestrator, @supports_vision, @created_at
    )
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      avatar = excluded.avatar,
      description = excluded.description,
      capabilities = excluded.capabilities,
      system_prompt = excluded.system_prompt,
      adapter_name = excluded.adapter_name,
      model_provider = excluded.model_provider,
      model_id = excluded.model_id,
      api_key = excluded.api_key,
      api_base_url = excluded.api_base_url,
      tool_names = excluded.tool_names,
      is_builtin = excluded.is_builtin,
      is_orchestrator = excluded.is_orchestrator,
      supports_vision = excluded.supports_vision,
      created_at = excluded.created_at
  `)
  const tx = sqlite.transaction((items: readonly AgentRow[]) => {
    for (const agent of items) upsert.run(toDbParams(agent))
    const customIds = Array.from(ids).filter((id) => items.find((agent) => agent.id === id)?.isBuiltin === false)
    if (customIds.length === 0) {
      sqlite.prepare('DELETE FROM agents WHERE is_builtin = 0').run()
    } else {
      sqlite
        .prepare(`DELETE FROM agents WHERE is_builtin = 0 AND id NOT IN (${customIds.map(() => '?').join(',')})`)
        .run(...customIds)
    }
  })
  tx(agents)
}

export function sortAgents(agents: readonly AgentRow[]): AgentRow[] {
  return [...agents].sort((a, b) => {
    if (a.isBuiltin !== b.isBuiltin) return a.isBuiltin ? -1 : 1
    return a.createdAt - b.createdAt || a.name.localeCompare(b.name)
  })
}

function fromDbRow(row: AgentDbRow): AgentRow {
  return {
    id: row.id,
    name: row.name,
    avatar: row.avatar,
    description: row.description,
    capabilities: jsonStringArray(row.capabilities),
    systemPrompt: row.system_prompt,
    adapterName: adapterValue(row.adapter_name),
    modelProvider: providerValue(row.model_provider),
    modelId: row.model_id,
    apiKey: row.api_key,
    apiBaseUrl: row.api_base_url,
    toolNames: jsonStringArray(row.tool_names),
    isBuiltin: row.is_builtin === 1,
    isOrchestrator: row.is_orchestrator === 1,
    supportsVision: row.supports_vision === 1,
    createdAt: row.created_at,
  }
}

function toDbParams(agent: AgentRow) {
  return {
    id: agent.id,
    name: agent.name,
    avatar: agent.avatar,
    description: agent.description,
    capabilities: JSON.stringify(agent.capabilities),
    system_prompt: agent.systemPrompt,
    adapter_name: agent.adapterName,
    model_provider: agent.modelProvider ?? null,
    model_id: agent.modelId ?? null,
    api_key: agent.apiKey ?? null,
    api_base_url: agent.apiBaseUrl ?? null,
    tool_names: JSON.stringify(agent.toolNames),
    is_builtin: agent.isBuiltin ? 1 : 0,
    is_orchestrator: agent.isOrchestrator ? 1 : 0,
    supports_vision: agent.supportsVision ? 1 : 0,
    created_at: agent.createdAt,
  }
}

function jsonStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function adapterValue(value: string): AgentRow['adapterName'] {
  if (value === 'claude-code' || value === 'codex' || value === 'custom' || value === 'mock') return value
  return 'custom'
}

function providerValue(value: string | null): AgentRow['modelProvider'] {
  if (
    value === 'anthropic' ||
    value === 'openai' ||
    value === 'deepseek' ||
    value === 'volcano-ark' ||
    value === 'openai-compatible'
  ) {
    return value
  }
  return null
}
