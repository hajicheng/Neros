import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import type Database from 'better-sqlite3'

import { BUILTIN_AGENTS } from './builtin-agents'
import type { AgentRow } from './schema'

const DDL = [
  `CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    avatar TEXT NOT NULL,
    description TEXT NOT NULL,
    capabilities TEXT NOT NULL,
    system_prompt TEXT NOT NULL,
    adapter_name TEXT NOT NULL,
    model_provider TEXT,
    model_id TEXT,
    api_key TEXT,
    api_base_url TEXT,
    tool_names TEXT NOT NULL,
    is_builtin INTEGER NOT NULL DEFAULT 0,
    is_orchestrator INTEGER NOT NULL DEFAULT 0,
    supports_vision INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    parent_artifact_id TEXT,
    created_by_agent_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_artifacts_conv ON artifacts(conversation_id)`,
]

export function bootstrapDatabase(sqlite: Database.Database, dataDir: string): void {
  ensureSchema(sqlite)
  ensureBuiltinAgents(sqlite)
  upgradeBuiltinAgents(sqlite)
  importLegacyAgentsJson(sqlite, path.join(dataDir, 'agents.json'))
}

function ensureSchema(sqlite: Database.Database): void {
  for (const stmt of DDL) sqlite.exec(stmt)
}

function ensureBuiltinAgents(sqlite: Database.Database): void {
  const insert = sqlite.prepare(`
    INSERT OR IGNORE INTO agents (
      id, name, avatar, description, capabilities, system_prompt,
      adapter_name, model_provider, model_id, api_key, api_base_url,
      tool_names, is_builtin, is_orchestrator, supports_vision, created_at
    ) VALUES (
      @id, @name, @avatar, @description, @capabilities, @system_prompt,
      @adapter_name, @model_provider, @model_id, @api_key, @api_base_url,
      @tool_names, @is_builtin, @is_orchestrator, @supports_vision, @created_at
    )
  `)

  const tx = sqlite.transaction((agents: typeof BUILTIN_AGENTS) => {
    for (const agent of agents) insert.run(toDbParams(agent))
  })
  tx(BUILTIN_AGENTS)
}

function upgradeBuiltinAgents(sqlite: Database.Database): void {
  const update = sqlite.prepare(`
    UPDATE agents SET
      name = @name,
      avatar = @avatar,
      description = @description,
      capabilities = @capabilities,
      system_prompt = @system_prompt,
      adapter_name = @adapter_name,
      model_provider = @model_provider,
      model_id = @model_id,
      tool_names = @tool_names,
      is_builtin = 1,
      is_orchestrator = @is_orchestrator,
      supports_vision = @supports_vision
    WHERE id = @id AND is_builtin = 1
  `)

  const tx = sqlite.transaction((agents: typeof BUILTIN_AGENTS) => {
    for (const agent of agents) update.run(toDbParams(agent))
  })
  tx(BUILTIN_AGENTS)
}

function importLegacyAgentsJson(sqlite: Database.Database, legacyPath: string): void {
  if (!existsSync(legacyPath)) return

  let agents: AgentRow[]
  try {
    const raw = JSON.parse(readFileSync(legacyPath, 'utf8'))
    agents = Array.isArray(raw) ? (raw as AgentRow[]) : []
  } catch {
    return
  }

  const builtinIds = new Set(BUILTIN_AGENTS.map((agent) => agent.id))
  const insert = sqlite.prepare(`
    INSERT OR IGNORE INTO agents (
      id, name, avatar, description, capabilities, system_prompt,
      adapter_name, model_provider, model_id, api_key, api_base_url,
      tool_names, is_builtin, is_orchestrator, supports_vision, created_at
    ) VALUES (
      @id, @name, @avatar, @description, @capabilities, @system_prompt,
      @adapter_name, @model_provider, @model_id, @api_key, @api_base_url,
      @tool_names, @is_builtin, @is_orchestrator, @supports_vision, @created_at
    )
  `)

  const tx = sqlite.transaction((items: AgentRow[]) => {
    for (const agent of items) {
      if (!agent?.id || builtinIds.has(agent.id)) continue
      insert.run(toDbParams({ ...agent, isBuiltin: false }))
    }
  })
  tx(agents)
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
