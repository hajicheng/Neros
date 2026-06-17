import type { NextRequest } from 'next/server'

import type { AgentRow, AppSettingsRow, AttachmentRow, ConversationWithMeta, MessageRow } from '@/db/schema'

export const dynamic = 'force-dynamic'

type RouteContext = {
  params: Promise<{ path?: string[] }>
}

const now = () => Date.now()

const agents: AgentRow[] = []
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
    return data({ agents })
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
    return data({ artifacts: [] })
  }

  if (path === 'fs/listdir') {
    return data({ path: '/', parent: null, entries: [] })
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
    if (parts[2] === 'pending-writes') return data({ pendingWrites: [] })
    if (parts[2] === 'pending-bash-commands') return data({ pendingCommands: [] })
    if (parts[2] === 'pending-questions') return data({ pendingQuestions: [] })
    if (parts[2] === 'pending-dispatch-plans') return data({ pendingDispatchPlans: [] })
    if (parts[2] === 'deploy') return data({ candidates: [] })
    if (parts[2] === 'fs' && parts[3] === 'listdir') {
      return data({ relPath: '', absolutePath: '', parent: null, entries: [] })
    }
    if (parts[2] === 'fs' && parts[3] === 'read') {
      const relPath = req.nextUrl.searchParams.get('path') ?? ''
      return data({ path: relPath, absolutePath: relPath, cwd: '', size: 0, content: '', truncated: false })
    }
  }

  if (parts[0] === 'artifacts' && parts[1] && parts[2] === 'versions') {
    return data({ versions: [] })
  }

  return data({ ok: false, error: `No local stub for /api/${path}` }, { status: 501 })
}

export async function POST(req: NextRequest, context: RouteContext) {
  const path = await getPath(context)
  const parts = pathParts(path)
  const body = await readJson(req)

  if (path === 'agents') {
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
      const message: MessageRow = {
        id: messageId,
        conversationId,
        role: 'user',
        agentId: null,
        parts: [{ type: 'text', content: stringFromBody(body, 'content', '') }],
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
      return data({ messageId, runIds: [], messages: [message] }, { status: 202 })
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
      return data({ path: relPath, absolutePath: relPath, cwd: '', bytes: content.length })
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
    return data({ error: 'Local stub has no artifact storage' }, { status: 501 })
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
    const agent = agents.find((item) => item.id === parts[1])
    if (!agent) return data({ error: 'Agent not found' }, { status: 404 })
    Object.assign(agent, body)
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
    removeById(agents, parts[1])
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

function streamResponse(req: NextRequest): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'connected' })}\n\n`))
      const interval = setInterval(() => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'heartbeat', conversationId: '', timestamp: now() })}\n\n`))
      }, 25000)
      req.signal.addEventListener('abort', () => {
        clearInterval(interval)
        controller.close()
      })
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  })
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
