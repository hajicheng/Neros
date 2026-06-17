import type {
  AdapterName,
  ArtifactContent,
  ArtifactType,
  MessagePart,
  MessageUsageEvent,
  ModelProvider,
} from '@/shared/types'

export interface MessageUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
}

export interface RunUsage {
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  lastInputTokens?: number
  model?: string
}

export interface AppSettingsRow {
  id: string
  anthropicApiKey: string | null
  anthropicBaseUrl: string | null
  openaiApiKey: string | null
  deepseekApiKey: string | null
  arkApiKey: string | null
  deploymentPublishEnabled: boolean
  deploymentPublishDir: string | null
  deploymentPublicBaseUrl: string | null
  updatedAt: number
}

export type AppSettingsInsert = Partial<AppSettingsRow> & { id: string }

export interface AgentRow {
  id: string
  name: string
  avatar: string
  description: string
  capabilities: string[]
  systemPrompt: string
  adapterName: AdapterName
  modelProvider: ModelProvider | null
  modelId: string | null
  apiKey: string | null
  apiBaseUrl: string | null
  toolNames: string[]
  isBuiltin: boolean
  isOrchestrator: boolean
  supportsVision: boolean
  createdAt: number
}

export type AgentInsert = Omit<AgentRow, 'createdAt'> & { createdAt?: number }

export interface ConversationRow {
  id: string
  title: string
  mode: 'single' | 'group'
  agentIds: string[]
  pinnedMessageIds: string[]
  bookmarkedMessageIds: string[]
  archived: boolean
  pinnedAt: number | null
  fsWriteApprovalMode: 'auto' | 'review'
  createdAt: number
  updatedAt: number
}

export type ConversationInsert = Omit<ConversationRow, 'createdAt' | 'updatedAt'> &
  Partial<Pick<ConversationRow, 'createdAt' | 'updatedAt'>>

export interface ConversationWithMeta extends ConversationRow {
  workspaceMode: 'sandbox' | 'local'
  workspaceBoundPath: string | null
}

export interface MessageRow {
  id: string
  conversationId: string
  role: 'user' | 'agent' | 'system'
  agentId: string | null
  parts: MessagePart[]
  status: 'streaming' | 'complete' | 'error' | 'aborted'
  parentMessageId: string | null
  mentionedAgentIds: string[]
  runId: string | null
  usage: MessageUsageEvent | null
  createdAt: number
}

export type MessageInsert = Omit<MessageRow, 'createdAt'> & { createdAt?: number }

export interface ArtifactRow {
  id: string
  conversationId: string
  type: ArtifactType
  title: string
  content: ArtifactContent
  version: number
  parentArtifactId: string | null
  createdByAgentId: string
  createdAt: number
}

export type ArtifactInsert = Omit<ArtifactRow, 'createdAt'> & { createdAt?: number }

export interface WorkspaceRow {
  id: string
  conversationId: string
  rootPath: string
  mode: 'sandbox' | 'local'
  boundPath: string | null
  createdAt: number
}

export type WorkspaceInsert = Omit<WorkspaceRow, 'createdAt'> & { createdAt?: number }

export interface AttachmentRow {
  id: string
  conversationId: string
  kind: 'image' | 'file'
  fileName: string
  filePath: string
  size: number
  mimeType: string
  createdAt: number
}

export type AttachmentInsert = Omit<AttachmentRow, 'createdAt'> & { createdAt?: number }

export interface AgentRunRow {
  id: string
  conversationId: string
  agentId: string
  triggerMessageId: string | null
  status: 'queued' | 'running' | 'complete' | 'failed' | 'aborted'
  error: string | null
  parentRunId: string | null
  usage: RunUsage | null
  startedAt: number
  finishedAt: number | null
}

export type AgentRunInsert = Omit<AgentRunRow, 'startedAt'> & { startedAt?: number }

export interface ContextSummaryRow {
  id: string
  conversationId: string
  summary: string
  coveredUntilMessageId: string
  coveredUntilCreatedAt: number
  sourceMessageCount: number
  tokenEstimate: number
  modelProvider: ModelProvider | null
  modelId: string | null
  createdAt: number
}

export type ContextSummaryInsert = Omit<ContextSummaryRow, 'createdAt'> & { createdAt?: number }
