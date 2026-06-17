import type { NextRequest } from 'next/server'

import { loadAgents, saveAgents, sortAgents } from '@/db/agent-store'
import type { AgentRow, AppSettingsRow, AttachmentRow, ConversationWithMeta, MessageRow } from '@/db/schema'
import { buildArtifactContent } from '@/server/artifact-content'
import {
  createArtifactVersion,
  deleteArtifact,
  findArtifact,
  listArtifacts,
  listArtifactVersions,
} from '@/server/artifact-store'
import { startAgentReply } from '@/server/agent-runner'
import { broadcastEvent, streamResponse } from '@/server/event-stream'
import { pendingBashCommands } from '@/server/pending-bash-commands'
import { pendingWrites } from '@/server/pending-writes'
import {
  listHostDirectory,
  listWorkspaceDirectory,
  readWorkspaceFile,
  writeWorkspaceFile,
} from '@/server/workspace-service'
import { buildWebAppHtml } from '@/lib/artifact-preview'
import type { ArtifactContent } from '@/shared/types'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type RouteContext = {
  params: Promise<{ path?: string[] }>
}

const now = () => Date.now()

let agents: AgentRow[] = loadAgents()
const conversations: ConversationWithMeta[] = []
const messagesByConversation = new Map<string, MessageRow[]>()
const attachmentsByConversation = new Map<string, AttachmentRow[]>()

let settings: AppSettingsRow = {
  id: 'singleton',
  anthropicApiKey: null,
  anthropicBaseUrl: null,
  openaiApiKey: null,
  deepseekApiKey: null,
  arkApiKey: null,
  deploymentPublishEnabled: false,
  deploymentPublishDir: null,
  deploymentPublicBaseUrl: null,
  updatedAt: now(),
}

export async function GET(req: NextRequest, context: RouteContext) {
  const path = await getPath(context)

  if (path === 'stream') {
    return streamResponse(req)
  }

  if (path === 'agents') {
    return data({ agents: sortAgents(refreshAgents()) })
  }

  if (path === 'conversations') {
    return data({ conversations })
  }

  if (path === 'platform') {
    return data({ platform: process.platform === 'win32' ? 'windows' : 'posix' })
  }

  if (path === 'settings') {
    return data({ settings })
  }

  if (path === 'usage/summary') {
    return data({
      today: emptyUsageBucket(),
      week: emptyUsageBucket(),
      allTime: emptyUsageBucket(),
      topConversations: [],
      byAgent: [],
      byModel: [],
    })
  }

  if (path === 'search') {
    return data({ ok: true, data: { hits: [], total: 0, tookMs: 0 } })
  }

  if (path === 'artifacts') {
    return data({ artifacts: listArtifacts(conversations) })
  }

  if (path === 'fs/listdir') {
    const targetPath = req.nextUrl.searchParams.get('path') ?? process.cwd()
    return data(listHostDirectory(targetPath))
  }

  const parts = pathParts(path)
  if (parts[0] === 'conversations' && parts[1]) {
    const conversationId = parts[1]
    if (parts[2] === 'messages') {
      return data({ messages: messagesByConversation.get(conversationId) ?? [] })
    }
    if (parts[2] === 'attachments') {
      return data({ attachments: attachmentsByConversation.get(conversationId) ?? [] })
    }
    if (parts[2] === 'pending-writes') {
      return data({ pendingWrites: pendingWrites.listByConversation(conversationId) })
    }
    if (parts[2] === 'pending-bash-commands') {
      return data({ pendingCommands: pendingBashCommands.listByConversation(conversationId) })
    }
    if (parts[2] === 'pending-questions') return data({ pendingQuestions: [] })
    if (parts[2] === 'pending-dispatch-plans') return data({ pendingDispatchPlans: [] })
    if (parts[2] === 'deploy') return data({ candidates: [] })
    if (parts[2] === 'fs' && parts[3] === 'listdir') {
      const relPath = req.nextUrl.searchParams.get('path') ?? ''
      const conversation = conversations.find((item) => item.id === conversationId)
      if (!conversation) return data({ error: 'Conversation not found' }, { status: 404 })
      return data(listWorkspaceDirectory(conversation, relPath))
    }
    if (parts[2] === 'fs' && parts[3] === 'read') {
      const relPath = req.nextUrl.searchParams.get('path') ?? ''
      const conversation = conversations.find((item) => item.id === conversationId)
      if (!conversation) return data({ error: 'Conversation not found' }, { status: 404 })
      return data(readWorkspaceFile(conversation, relPath))
    }
  }

  if (parts[0] === 'artifacts' && parts[1]) {
    if (parts[2] === 'preview') {
      const artifact = findArtifact(parts[1])
      if (!artifact) return data({ error: 'Artifact not found' }, { status: 404 })
      return artifactPreviewResponse(artifact.content)
    }
    if (parts[2] === 'versions') return data({ versions: listArtifactVersions(parts[1]) })
    const artifact = findArtifact(parts[1])
    if (!artifact) return data({ error: 'Artifact not found' }, { status: 404 })
    return data({ artifact })
  }

  return data({ ok: false, error: `No local stub for /api/${path}` }, { status: 501 })
}

export async function POST(req: NextRequest, context: RouteContext) {
  const path = await getPath(context)
  const parts = pathParts(path)
  const body = await readJson(req)

  if (path === 'agents') {
    refreshAgents()
    const agent: AgentRow = {
      id: `agent_${now()}`,
      name: stringFromBody(body, 'name', 'New Agent'),
      avatar: stringFromBody(body, 'avatar', '🤖'),
      description: stringFromBody(body, 'description', ''),
      capabilities: arrayFromBody(body, 'capabilities'),
      systemPrompt: stringFromBody(body, 'systemPrompt', ''),
      adapterName: adapterFromBody(body),
      modelProvider: providerFromBody(body),
      modelId: nullableStringFromBody(body, 'modelId'),
      apiKey: nullableStringFromBody(body, 'apiKey'),
      apiBaseUrl: nullableStringFromBody(body, 'apiBaseUrl'),
      toolNames: arrayFromBody(body, 'toolNames'),
      isBuiltin: false,
      isOrchestrator: false,
      supportsVision: booleanFromBody(body, 'supportsVision'),
      createdAt: now(),
    }
    agents.push(agent)
    saveAgents(agents)
    return data({ agent }, { status: 201 })
  }

  if (path === 'agents/draft') {
    return data({
      draft: {
        name: 'New Agent',
        avatar: '🤖',
        description: '',
        capabilities: [],
        systemPrompt: '',
        adapterName: 'custom',
        modelProvider: 'openai-compatible',
        modelId: '',
        toolNames: [],
        supportsVision: false,
        assumptions: [],
        toolPermissionSummary: [],
      },
    })
  }

  if (path === 'conversations') {
    const conversation: ConversationWithMeta = {
      id: `conv_${now()}`,
      title: stringFromBody(body, 'title', '新对话'),
      mode: body && typeof body === 'object' && body.mode === 'group' ? 'group' : 'single',
      agentIds: arrayFromBody(body, 'agentIds'),
      pinnedMessageIds: [],
      bookmarkedMessageIds: [],
      archived: false,
      pinnedAt: null,
      fsWriteApprovalMode: 'review',
      workspaceMode: nullableStringFromBody(body, 'boundPath') ? 'local' : 'sandbox',
      workspaceBoundPath: nullableStringFromBody(body, 'boundPath'),
      createdAt: now(),
      updatedAt: now(),
    }
    conversations.unshift(conversation)
    messagesByConversation.set(conversation.id, [])
    return data({ conversation }, { status: 201 })
  }

  if (parts[0] === 'conversations' && parts[1]) {
    const conversationId = parts[1]
    if (parts[2] === 'messages') {
      const messageId = `msg_${now()}`
      const content = stringFromBody(body, 'content', '')
      const message: MessageRow = {
        id: messageId,
        conversationId,
        role: 'user',
        agentId: null,
        parts: [{ type: 'text', content }],
        status: 'complete',
        parentMessageId: nullableStringFromBody(body, 'parentMessageId'),
        mentionedAgentIds: arrayFromBody(body, 'mentionedAgentIds'),
        runId: null,
        usage: null,
        createdAt: now(),
      }
      const bucket = messagesByConversation.get(conversationId) ?? []
      bucket.push(message)
      messagesByConversation.set(conversationId, bucket)
      broadcastEvent({
        type: 'message.added',
        conversationId,
        message,
        timestamp: message.createdAt,
      })
      const runId = startAgentReply({
        agents: refreshAgents(),
        conversation: conversations.find((item) => item.id === conversationId),
        bucket,
        triggerMessage: message,
        broadcast: broadcastEvent,
      })
      return data({ messageId, runIds: runId ? [runId] : [], messages: [message] }, { status: 202 })
    }
    if (parts[2] === 'compact') return data({ error: 'Local stub has no conversation history' }, { status: 501 })
    if (parts[2] === 'regenerate') return data({ deletedMessageIds: [], deletedArtifactIds: [], triggerMessageId: '', runIds: [] })
    if (parts[2] === 'deploy') {
      return data({
        kind: 'no_candidates',
        candidates: [],
        message: emptySystemMessage(conversationId, '暂无可部署产物'),
      })
    }
    if (parts[2] === 'fs' && parts[3] === 'write') {
      const relPath = stringFromBody(body, 'path', '')
      const content = stringFromBody(body, 'content', '')
      const conversation = conversations.find((item) => item.id === conversationId)
      if (!conversation) return data({ error: 'Conversation not found' }, { status: 404 })
      return data(writeWorkspaceFile(conversation, relPath, content))
    }
    if (parts[2] === 'pending-writes' && parts[3]) {
      const action = stringFromBody(body, 'action', '')
      const ok = action === 'approve' ? pendingWrites.approve(parts[3]) : pendingWrites.reject(parts[3])
      return ok ? data({ ok: true }) : data({ error: 'Pending write not found' }, { status: 404 })
    }
    if (parts[2] === 'pending-bash-commands' && parts[3]) {
      const action = stringFromBody(body, 'action', '')
      const ok = action === 'approve' ? pendingBashCommands.approve(parts[3]) : pendingBashCommands.reject(parts[3])
      return ok ? data({ ok: true }) : data({ error: 'Pending command not found' }, { status: 404 })
    }
    if (parts[2]?.startsWith('pending-')) return data({ ok: true })
  }

  if (parts[0] === 'messages' && parts[1]) {
    if (parts[2] === 'withdraw') return data({ deletedMessageIds: [parts[1]], deletedArtifactIds: [] })
    if (parts[2] === 'edit') {
      return data({ deletedMessageIds: [parts[1]], deletedArtifactIds: [], newMessage: emptySystemMessage('', ''), runIds: [] })
    }
    if (parts[2] === 'bookmark') return data({ bookmarkedMessageIds: [], bookmarked: false })
    if (parts[2] === 'pin') return data({ pinnedMessageIds: [], pinned: false })
  }

  if (parts[0] === 'runs' && parts[2] === 'abort') return data({ ok: true })

  if (parts[0] === 'artifacts' && parts[1] && parts[2] === 'versions') {
    const parent = findArtifact(parts[1])
    if (!parent) return data({ error: 'Artifact not found' }, { status: 404 })
    const content = buildArtifactContent(parent.type, body?.content)
    if (!content) return data({ error: 'Invalid artifact content' }, { status: 400 })
    const artifact = createArtifactVersion({
      parentArtifactId: parent.id,
      title: nullableStringFromBody(body, 'title') ?? undefined,
      content,
    })
    if (!artifact) return data({ error: 'Artifact not found' }, { status: 404 })
    broadcastEvent({
      type: 'artifact.create',
      conversationId: artifact.conversationId,
      artifact: { ...artifact, parentArtifactId: artifact.parentArtifactId ?? undefined },
      timestamp: artifact.createdAt,
    })
    return data({ artifact }, { status: 201 })
  }

  return data({ ok: true })
}

export async function PATCH(req: NextRequest, context: RouteContext) {
  const path = await getPath(context)
  const body = await readJson(req)
  const parts = pathParts(path)

  if (path === 'settings') {
    settings = {
      ...settings,
      ...settingsPatch(body),
      updatedAt: now(),
    }
    return data({ settings })
  }

  if (parts[0] === 'agents' && parts[1]) {
    const agent = refreshAgents().find((item) => item.id === parts[1])
    if (!agent) return data({ error: 'Agent not found' }, { status: 404 })
    Object.assign(agent, body)
    saveAgents(agents)
    return data({ agent })
  }

  if (parts[0] === 'conversations' && parts[1]) {
    const conversation = conversations.find((item) => item.id === parts[1])
    if (!conversation) return data({ error: 'Conversation not found' }, { status: 404 })
    if (body && typeof body === 'object') {
      if (typeof body.title === 'string') conversation.title = body.title
      if (Array.isArray(body.addAgentIds)) {
        conversation.agentIds = Array.from(new Set([...conversation.agentIds, ...body.addAgentIds.filter((id) => typeof id === 'string')]))
      }
      if (body.togglePin) conversation.pinnedAt = conversation.pinnedAt ? null : now()
      if (body.toggleArchive) conversation.archived = !conversation.archived
      if (body.fsWriteApprovalMode === 'auto' || body.fsWriteApprovalMode === 'review') {
        conversation.fsWriteApprovalMode = body.fsWriteApprovalMode
      }
      conversation.updatedAt = now()
    }
    return data({ conversation })
  }

  return data({ ok: true })
}

export async function DELETE(_req: NextRequest, context: RouteContext) {
  const path = await getPath(context)
  const parts = pathParts(path)

  if (parts[0] === 'agents' && parts[1]) {
    const agent = refreshAgents().find((item) => item.id === parts[1])
    if (agent?.isBuiltin) return data({ error: 'Builtin agents cannot be deleted' }, { status: 403 })
    removeById(agents, parts[1])
    saveAgents(agents)
    return data({ ok: true })
  }

  if (parts[0] === 'conversations' && parts[1]) {
    if (parts[2] === 'messages') {
      messagesByConversation.set(parts[1], [])
      const conversation = conversations.find((item) => item.id === parts[1]) ?? emptyConversation(parts[1])
      return data({ conversation, deletedMessageCount: 0, deletedRunCount: 0, deletedSummaryCount: 0 })
    }
    removeById(conversations, parts[1])
    messagesByConversation.delete(parts[1])
    return data({ ok: true })
  }

  if (parts[0] === 'artifacts' && parts[1]) {
    const ok = deleteArtifact(parts[1])
    return ok ? data({ ok: true }) : data({ error: 'Artifact not found' }, { status: 404 })
  }

  return data({ ok: true })
}

async function getPath(context: RouteContext): Promise<string> {
  const params = await context.params
  return (params.path ?? []).join('/')
}

function pathParts(path: string): string[] {
  return path.split('/').filter(Boolean)
}

function data(payload: unknown, init?: ResponseInit): Response {
  return Response.json(payload, init)
}

function artifactPreviewResponse(content: ArtifactContent): Response {
  if (content.type !== 'web_app') {
    return data({ error: 'Artifact is not a web_app' }, { status: 400 })
  }

  return new Response(buildWebAppHtml(content), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': [
        'sandbox allow-scripts',
        "default-src 'none'",
        "script-src 'unsafe-inline'",
        "style-src 'unsafe-inline'",
        'img-src data: blob: http: https:',
        'font-src data:',
        "connect-src 'none'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'self'",
      ].join('; '),
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
    },
  })
}

function refreshAgents(): AgentRow[] {
  agents = loadAgents()
  return agents
}

async function readJson(req: NextRequest): Promise<Record<string, unknown> | null> {
  try {
    const value = await req.json()
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function stringFromBody(body: Record<string, unknown> | null, key: string, fallback: string): string {
  const value = body?.[key]
  return typeof value === 'string' ? value : fallback
}

function nullableStringFromBody(body: Record<string, unknown> | null, key: string): string | null {
  const value = body?.[key]
  return typeof value === 'string' && value.trim() ? value : null
}

function arrayFromBody(body: Record<string, unknown> | null, key: string): string[] {
  const value = body?.[key]
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function booleanFromBody(body: Record<string, unknown> | null, key: string): boolean {
  return body?.[key] === true
}

function adapterFromBody(body: Record<string, unknown> | null): AgentRow['adapterName'] {
  const value = body?.adapterName
  return value === 'claude-code' || value === 'codex' || value === 'mock' ? value : 'custom'
}

function providerFromBody(body: Record<string, unknown> | null): AgentRow['modelProvider'] {
  const value = body?.modelProvider
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

function settingsPatch(body: Record<string, unknown> | null): Partial<AppSettingsRow> {
  if (!body) return {}
  return {
    anthropicApiKey: valueOrNull(body.anthropicApiKey),
    anthropicBaseUrl: valueOrNull(body.anthropicBaseUrl),
    openaiApiKey: valueOrNull(body.openaiApiKey),
    deepseekApiKey: valueOrNull(body.deepseekApiKey),
    arkApiKey: valueOrNull(body.arkApiKey),
    deploymentPublishEnabled: body.deploymentPublishEnabled === true,
    deploymentPublishDir: valueOrNull(body.deploymentPublishDir),
    deploymentPublicBaseUrl: valueOrNull(body.deploymentPublicBaseUrl),
  }
}

function valueOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function emptyUsageBucket() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    runs: 0,
  }
}

function emptySystemMessage(conversationId: string, content: string): MessageRow {
  return {
    id: `msg_${now()}`,
    conversationId,
    role: 'system',
    agentId: null,
    parts: [{ type: 'text', content }],
    status: 'complete',
    parentMessageId: null,
    mentionedAgentIds: [],
    runId: null,
    usage: null,
    createdAt: now(),
  }
}

function emptyConversation(id: string): ConversationWithMeta {
  return {
    id,
    title: '新对话',
    mode: 'single',
    agentIds: [],
    pinnedMessageIds: [],
    bookmarkedMessageIds: [],
    archived: false,
    pinnedAt: null,
    fsWriteApprovalMode: 'review',
    workspaceMode: 'sandbox',
    workspaceBoundPath: null,
    createdAt: now(),
    updatedAt: now(),
  }
}

function removeById<T extends { id: string }>(items: T[], id: string): void {
  const index = items.findIndex((item) => item.id === id)
  if (index >= 0) items.splice(index, 1)
}
