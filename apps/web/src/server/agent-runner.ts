import type { AgentRow, ArtifactRow, ConversationWithMeta, MessageRow } from '@/db/schema'
import { toolRegistry, type ToolDef } from '@/server/tools/registry'
import type { MessagePart, MessageUsageEvent, RunUsageEvent, StreamEvent } from '@/shared/types'

const HISTORY_MESSAGE_LIMIT = 20
const MAX_AGENT_TURNS = 6
const ENABLED_MODEL_TOOLS = new Set(['write_artifact', 'fs_list', 'fs_read', 'fs_write', 'bash'])

type Broadcast = (event: StreamEvent) => void

type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  reasoningContent?: string
  toolCalls?: ChatToolCall[]
  toolCallId?: string
}

type ChatToolCall = {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

type AccumulatingToolCall = {
  id: string
  name: string
  argsBuffer: string
}

type ChatCompletionChunk = {
  choices?: Array<{
    delta?: {
      content?: string | null
      reasoning_content?: string | null
      tool_calls?: Array<{
        index: number
        id?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_cache_hit_tokens?: number
  }
  error?: { message?: string }
}

type ChatProviderConfig = {
  baseUrl: string
  apiKey: string
  model: string
}

type StreamedModelEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'usage'; usage: MessageUsageEvent }
  | { type: 'tool_delta'; index: number; id?: string; name?: string; arguments?: string }
  | { type: 'finish'; reason: string }

export function startAgentReply(args: {
  agents: AgentRow[]
  conversation: ConversationWithMeta | undefined
  bucket: MessageRow[]
  triggerMessage: MessageRow
  broadcast: Broadcast
}): string | null {
  const agent = pickAgent(args.agents, args.conversation, args.triggerMessage)
  if (!agent) return null

  const runId = `run_${Date.now()}`
  const replyId = `msg_${Date.now()}_${agent.id}`
  const startedAt = Date.now()
  const conversationId = args.triggerMessage.conversationId
  const reply: MessageRow = {
    id: replyId,
    conversationId,
    role: 'agent',
    agentId: agent.id,
    parts: [],
    status: 'streaming',
    parentMessageId: args.triggerMessage.id,
    mentionedAgentIds: [],
    runId,
    usage: null,
    createdAt: startedAt,
  }

  args.bucket.push(reply)
  args.broadcast({
    type: 'run.start',
    conversationId,
    runId,
    agentId: agent.id,
    triggerMessageId: args.triggerMessage.id,
    timestamp: startedAt,
  })
  args.broadcast({
    type: 'message.start',
    conversationId,
    messageId: replyId,
    agentId: agent.id,
    runId,
    timestamp: startedAt,
  })

  void streamAgentReply({
    agent,
    conversation: args.conversation,
    bucket: args.bucket,
    reply,
    runId,
    broadcast: args.broadcast,
  })
  return runId
}

async function streamAgentReply(args: {
  agent: AgentRow
  conversation: ConversationWithMeta | undefined
  bucket: MessageRow[]
  reply: MessageRow
  runId: string
  broadcast: Broadcast
}): Promise<void> {
  const { agent, bucket, reply, runId, broadcast } = args
  const conversationId = reply.conversationId
  let totalTextLength = 0
  const usage: MessageUsageEvent = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }

  try {
    const chatMessages = buildChatMessages(agent, bucket.filter((message) => message.id !== reply.id))
    const toolDefs = args.conversation ? resolveModelTools(agent.toolNames) : []

    for (let turn = 0; turn < MAX_AGENT_TURNS; turn++) {
      let thinkingPartIndex = -1
      let textPartIndex = -1
      let textBuffer = ''
      let reasoningBuffer = ''
      let finishReason: string | null = null
      const toolCallBuffer = new Map<number, AccumulatingToolCall>()

      for await (const event of callChatCompletionStream(agent, chatMessages, toolDefs)) {
        if (event.type === 'reasoning' && event.text) {
          if (thinkingPartIndex < 0) {
            thinkingPartIndex = reply.parts.length
            startReplyPart(reply, broadcast, thinkingPartIndex, { type: 'thinking', content: '' })
          }
          reasoningBuffer += event.text
          appendReplyPart(reply, thinkingPartIndex, event.text)
          broadcast({
            type: 'part.delta',
            conversationId,
            messageId: reply.id,
            partIndex: thinkingPartIndex,
            delta: { type: 'thinking.append', text: event.text },
            timestamp: Date.now(),
          })
        } else if (event.type === 'text' && event.text) {
          if (textPartIndex < 0) {
            textPartIndex = reply.parts.length
            startReplyPart(reply, broadcast, textPartIndex, { type: 'text', content: '' })
          }
          textBuffer += event.text
          totalTextLength += event.text.length
          appendReplyPart(reply, textPartIndex, event.text)
          broadcast({
            type: 'part.delta',
            conversationId,
            messageId: reply.id,
            partIndex: textPartIndex,
            delta: { type: 'text.append', text: event.text },
            timestamp: Date.now(),
          })
        } else if (event.type === 'tool_delta') {
          const existing = toolCallBuffer.get(event.index) ?? { id: '', name: '', argsBuffer: '' }
          if (event.id) existing.id = event.id
          if (event.name) existing.name = event.name
          if (event.arguments) existing.argsBuffer += event.arguments
          toolCallBuffer.set(event.index, existing)
        } else if (event.type === 'usage') {
          usage.inputTokens += event.usage.inputTokens
          usage.outputTokens += event.usage.outputTokens
          usage.cacheReadTokens += event.usage.cacheReadTokens
        } else if (event.type === 'finish') {
          finishReason = event.reason
        }
      }

      endPartIfStarted(broadcast, reply, thinkingPartIndex)
      endPartIfStarted(broadcast, reply, textPartIndex)

      const toolCalls = Array.from(toolCallBuffer.values()).filter((call) => call.id && call.name)
      chatMessages.push({
        role: 'assistant',
        content: textBuffer || null,
        reasoningContent: reasoningBuffer || undefined,
        toolCalls: toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.argsBuffer || '{}' },
        })),
      })

      if (toolCalls.length === 0 || finishReason === 'stop' || !args.conversation) break

      for (const toolCall of toolCalls) {
        const toolArgs = parseToolArgs(toolCall.argsBuffer)
        addToolUsePart(reply, broadcast, toolCall.id, toolCall.name, toolArgs)
        const result = await toolRegistry.execute(toolCall.name, toolArgs, {
          conversation: args.conversation,
          agentId: agent.id,
          runId,
        })
        const rawValue = result.ok ? result.value : { error: result.error }
        const artifact = result.ok ? artifactFromToolResult(rawValue) : null
        if (artifact) {
          broadcast({
            type: 'artifact.create',
            conversationId,
            artifact: {
              ...artifact,
              parentArtifactId: artifact.parentArtifactId ?? undefined,
            },
            timestamp: Date.now(),
          })
        }

        const value = artifact ? compactArtifactToolResult(rawValue) : rawValue
        addToolResultPart(reply, broadcast, toolCall.id, value, !result.ok)
        if (artifact) addArtifactRefPart(reply, broadcast, artifact.id)
        chatMessages.push({
          role: 'tool',
          toolCallId: toolCall.id,
          content: JSON.stringify(value),
        })
      }
    }

    if (totalTextLength === 0) {
      const textPartIndex = reply.parts.length
      const fallback = '模型没有返回文本内容。'
      startReplyPart(reply, broadcast, textPartIndex, { type: 'text', content: '' })
      appendReplyPart(reply, textPartIndex, fallback)
      broadcast({
        type: 'part.delta',
        conversationId,
        messageId: reply.id,
        partIndex: textPartIndex,
        delta: { type: 'text.append', text: fallback },
        timestamp: Date.now(),
      })
      endPartIfStarted(broadcast, reply, textPartIndex)
    }

    reply.status = 'complete'
    reply.usage =
      usage.inputTokens > 0 || usage.outputTokens > 0 || usage.cacheReadTokens > 0
        ? usage
        : null
    finishStreamingReply(broadcast, runId, reply, 'complete', reply.usage, agent.modelId)
  } catch (err) {
    const errorText = renderAgentError(err)
    const textPartIndex = reply.parts.length
    startReplyPart(reply, broadcast, textPartIndex, { type: 'text', content: '' })
    appendReplyPart(reply, textPartIndex, errorText)
    reply.status = 'error'
    broadcast({
      type: 'part.delta',
      conversationId,
      messageId: reply.id,
      partIndex: textPartIndex,
      delta: { type: 'text.append', text: errorText },
      timestamp: Date.now(),
    })
    endPartIfStarted(broadcast, reply, textPartIndex)
    finishStreamingReply(broadcast, runId, reply, 'failed', null, agent.modelId, errorText)
  }
}

function pickAgent(
  agents: AgentRow[],
  conversation: ConversationWithMeta | undefined,
  triggerMessage: MessageRow,
): AgentRow | null {
  const mentioned = triggerMessage.mentionedAgentIds
    .map((id) => agents.find((agent) => agent.id === id))
    .find((agent): agent is AgentRow => !!agent)
  if (mentioned) return mentioned

  const firstConversationAgent = conversation?.agentIds
    .map((id) => agents.find((agent) => agent.id === id))
    .find((agent): agent is AgentRow => !!agent)
  if (firstConversationAgent) return firstConversationAgent

  return agents.find((agent) => agent.id === 'ag_neros') ?? agents[0] ?? null
}

function buildChatMessages(agent: AgentRow, bucket: MessageRow[]): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: 'system', content: agent.systemPrompt }]

  for (const message of bucket.slice(-HISTORY_MESSAGE_LIMIT)) {
    const content = messageText(message)
    if (!content || message.role === 'system') continue
    messages.push({
      role: message.role === 'agent' ? 'assistant' : 'user',
      content,
      reasoningContent: message.role === 'agent' ? messageThinkingText(message) : undefined,
    })
  }

  return messages
}

function messageText(message: MessageRow): string {
  return message.parts
    .map((part) => {
      if (part.type === 'text') return part.content
      if (part.type === 'code') return `\`\`\`${part.language}\n${part.content}\n\`\`\``
      if (part.type === 'file_attachment') return `[文件附件: ${part.fileName}]`
      if (part.type === 'image_attachment') return `[图片附件: ${part.fileName}]`
      if (part.type === 'artifact_ref') return `[产物: ${part.artifactId}]`
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function messageThinkingText(message: MessageRow): string | undefined {
  const text = message.parts
    .filter((part) => part.type === 'thinking')
    .map((part) => part.content)
    .filter(Boolean)
    .join('\n')
  return text || undefined
}

async function* callChatCompletionStream(
  agent: AgentRow,
  messages: ChatMessage[],
  tools: ToolDef[],
): AsyncIterable<StreamedModelEvent> {
  const config = chatProviderConfig(agent)
  const response = await fetch(`${config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: messages.map(toApiMessage),
      ...(tools.length > 0 ? { tools: tools.map(toApiTool) } : {}),
      stream: true,
      stream_options: { include_usage: true },
    }),
  })

  if (!response.ok) {
    const json = (await response.json().catch(() => null)) as ChatCompletionChunk | null
    const detail = json?.error?.message ? `: ${json.error.message}` : ''
    throw new Error(`模型请求失败 (${response.status})${detail}`)
  }
  if (!response.body) throw new Error('模型没有返回可读取的流')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (!data || data === '[DONE]') continue

        const chunk = JSON.parse(data) as ChatCompletionChunk
        const choice = chunk.choices?.[0]
        const reasoning = choice?.delta?.reasoning_content
        const text = choice?.delta?.content
        if (reasoning) yield { type: 'reasoning', text: reasoning }
        if (text) yield { type: 'text', text }
        for (const toolCall of choice?.delta?.tool_calls ?? []) {
          yield {
            type: 'tool_delta',
            index: toolCall.index,
            id: toolCall.id,
            name: toolCall.function?.name,
            arguments: toolCall.function?.arguments,
          }
        }
        if (chunk.usage) {
          yield {
            type: 'usage',
            usage: {
              inputTokens: chunk.usage.prompt_tokens ?? 0,
              outputTokens: chunk.usage.completion_tokens ?? 0,
              cacheReadTokens: chunk.usage.prompt_cache_hit_tokens ?? 0,
            },
          }
        }
        if (choice?.finish_reason) yield { type: 'finish', reason: choice.finish_reason }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

function resolveModelTools(names: string[]): ToolDef[] {
  return toolRegistry.resolve(names.filter((name) => ENABLED_MODEL_TOOLS.has(name)))
}

function toApiMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    return { role: 'tool', tool_call_id: message.toolCallId, content: message.content ?? '' }
  }
  if (message.role === 'assistant' && message.toolCalls?.length) {
    return {
      role: 'assistant',
      content: message.content,
      tool_calls: message.toolCalls,
      ...(message.reasoningContent ? { reasoning_content: message.reasoningContent } : {}),
    }
  }
  return {
    role: message.role,
    content: message.content ?? '',
    ...(message.role === 'assistant' && message.reasoningContent
      ? { reasoning_content: message.reasoningContent }
      : {}),
  }
}

function toApiTool(tool: ToolDef): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }
}

function parseToolArgs(value: string): unknown {
  try {
    return value ? JSON.parse(value) : {}
  } catch {
    return {}
  }
}

function artifactFromToolResult(value: unknown): ArtifactRow | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const artifact = (value as Record<string, unknown>).artifact
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) return null
  const candidate = artifact as Partial<ArtifactRow>
  return typeof candidate.id === 'string' &&
    typeof candidate.conversationId === 'string' &&
    typeof candidate.type === 'string' &&
    typeof candidate.title === 'string' &&
    typeof candidate.version === 'number' &&
    typeof candidate.createdByAgentId === 'string' &&
    typeof candidate.createdAt === 'number' &&
    !!candidate.content
    ? (candidate as ArtifactRow)
    : null
}

function compactArtifactToolResult(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const { artifact: _artifact, ...rest } = value as Record<string, unknown>
  return rest
}

function addToolUsePart(
  reply: MessageRow,
  broadcast: Broadcast,
  callId: string,
  toolName: string,
  args: unknown,
): void {
  reply.parts.push({ type: 'tool_use', callId, toolName, args })
  broadcast({
    type: 'tool.call',
    conversationId: reply.conversationId,
    messageId: reply.id,
    callId,
    toolName,
    args,
    timestamp: Date.now(),
  })
}

function addArtifactRefPart(reply: MessageRow, broadcast: Broadcast, artifactId: string): void {
  const partIndex = reply.parts.length
  startReplyPart(reply, broadcast, partIndex, { type: 'artifact_ref', artifactId })
  endPartIfStarted(broadcast, reply, partIndex)
}

function addToolResultPart(
  reply: MessageRow,
  broadcast: Broadcast,
  callId: string,
  result: unknown,
  isError: boolean,
): void {
  reply.parts.push({ type: 'tool_result', callId, result, isError })
  broadcast({
    type: 'tool.result',
    conversationId: reply.conversationId,
    messageId: reply.id,
    callId,
    result,
    isError,
    timestamp: Date.now(),
  })
}

function appendReplyPart(reply: MessageRow, partIndex: number, text: string): void {
  const part = reply.parts[partIndex]
  if (!part) return
  if ((part.type === 'text' || part.type === 'thinking' || part.type === 'code') && text) {
    part.content += text
  }
}

function startReplyPart(reply: MessageRow, broadcast: Broadcast, partIndex: number, part: MessagePart): void {
  reply.parts[partIndex] = part
  broadcast({
    type: 'part.start',
    conversationId: reply.conversationId,
    messageId: reply.id,
    partIndex,
    part,
    timestamp: Date.now(),
  })
}

function endPartIfStarted(broadcast: Broadcast, reply: MessageRow, partIndex: number): void {
  if (partIndex < 0) return
  broadcast({
    type: 'part.end',
    conversationId: reply.conversationId,
    messageId: reply.id,
    partIndex,
    timestamp: Date.now(),
  })
}

function finishStreamingReply(
  broadcast: Broadcast,
  runId: string,
  reply: MessageRow,
  status: 'complete' | 'failed',
  usage: MessageUsageEvent | null,
  modelId: string | null,
  error?: string,
): void {
  const timestamp = Date.now()
  if (usage) {
    const runUsage: RunUsageEvent = {
      ...usage,
      cacheCreationTokens: 0,
      lastInputTokens: usage.inputTokens,
      model: modelId ?? undefined,
    }
    broadcast({ type: 'message.usage', conversationId: reply.conversationId, messageId: reply.id, usage, timestamp })
    broadcast({ type: 'run.usage', conversationId: reply.conversationId, runId, usage: runUsage, timestamp })
  }
  broadcast({ type: 'message.end', conversationId: reply.conversationId, messageId: reply.id, timestamp })
  broadcast({ type: 'run.end', conversationId: reply.conversationId, runId, status, error, timestamp })
}

function chatProviderConfig(agent: AgentRow): ChatProviderConfig {
  const provider = agent.modelProvider ?? 'deepseek'
  const model = agent.modelId?.trim() || providerDefaultModel(provider)
  const baseUrl = agent.apiBaseUrl?.trim() || providerDefaultBaseUrl(provider)
  const apiKey = agent.apiKey?.trim() || providerApiKey(provider)
  if (!apiKey) throw new Error(`缺少 ${providerApiKeyName(provider)}，请检查 apps/web/.env.local 或 Agent 配置。`)
  return { baseUrl, apiKey, model }
}

function providerDefaultBaseUrl(provider: AgentRow['modelProvider']): string {
  switch (provider) {
    case 'openai':
    case 'openai-compatible':
      return 'https://api.openai.com/v1'
    case 'volcano-ark':
      return 'https://ark.cn-beijing.volces.com/api/v3'
    case 'anthropic':
      return 'https://api.anthropic.com/v1'
    case 'deepseek':
    default:
      return 'https://api.deepseek.com/v1'
  }
}

function providerDefaultModel(provider: AgentRow['modelProvider']): string {
  switch (provider) {
    case 'openai':
    case 'openai-compatible':
      return 'gpt-4o'
    case 'volcano-ark':
      return 'doubao-seed-2-0-lite-260428'
    case 'anthropic':
      return 'claude-opus-4-7'
    case 'deepseek':
    default:
      return 'deepseek-v4-flash'
  }
}

function providerApiKey(provider: AgentRow['modelProvider']): string {
  switch (provider) {
    case 'openai':
    case 'openai-compatible':
      return process.env.OPENAI_API_KEY ?? ''
    case 'volcano-ark':
      return process.env.ARK_API_KEY ?? ''
    case 'anthropic':
      return process.env.ANTHROPIC_API_KEY ?? ''
    case 'deepseek':
    default:
      return process.env.DEEPSEEK_API_KEY ?? process.env.NEROS_API_KEY ?? ''
  }
}

function providerApiKeyName(provider: AgentRow['modelProvider']): string {
  switch (provider) {
    case 'openai':
    case 'openai-compatible':
      return 'OPENAI_API_KEY'
    case 'volcano-ark':
      return 'ARK_API_KEY'
    case 'anthropic':
      return 'ANTHROPIC_API_KEY'
    case 'deepseek':
    default:
      return 'DEEPSEEK_API_KEY'
  }
}

function renderAgentError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return `Neros 暂时没能完成回复：${message}`
}
