import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import type { AgentRow, ArtifactRow, ConversationWithMeta, MessageRow } from '@/db/schema'
import { attachmentDataUrl } from '@/server/attachment-store'
import { toolRegistry, type ToolDef } from '@/server/tools/registry'
import type { MessagePart, MessageUsageEvent, RunUsageEvent, StreamEvent } from '@/shared/types'

const HISTORY_MESSAGE_LIMIT = 20
const MAX_AGENT_TURNS = 6
const ENABLED_MODEL_TOOLS = new Set([
  'write_artifact',
  'fs_list',
  'fs_read',
  'fs_write',
  'bash',
  'desktop_get_screen_info',
  'desktop_capture_screen',
  'desktop_mouse',
  'desktop_keyboard',
  'desktop_window',
  'app_launch',
  'browser_open',
  'browser_search',
])

type Broadcast = (event: StreamEvent) => void

type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: ChatContent | null
  reasoningContent?: string
  toolCalls?: ChatToolCall[]
  toolCallId?: string
}

type ChatContent =
  | string
  | Array<
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string } }
    >

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
  provider: AgentRow['modelProvider']
  baseUrl: string
  apiKey: string
  model: string
}

type ResponsesApiResponse = {
  output_text?: string
  output?: Array<{
    content?: Array<{
      type?: string
      text?: string
    }>
  }>
  usage?: {
    input_tokens?: number
    output_tokens?: number
  }
  error?: { message?: string }
}

type ResponsesContentPart =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string }

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
    if (args.conversation && shouldRunDirectScreenshot(args.bucket, reply.id)) {
      await runDirectScreenshot({
        conversation: args.conversation,
        reply,
        runId,
        broadcast,
        agent,
      })
      return
    }

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
        const modelValue = compactModelToolResult(value)
        addToolResultPart(reply, broadcast, toolCall.id, value, !result.ok)
        if (artifact) addArtifactRefPart(reply, broadcast, artifact.id)
        chatMessages.push({
          role: 'tool',
          toolCallId: toolCall.id,
          content: JSON.stringify(modelValue),
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
    const content =
      message.role === 'user' ? userMessageContent(agent, message) : messageText(message)
    if (!content || message.role === 'system') continue
    messages.push({
      role: message.role === 'agent' ? 'assistant' : 'user',
      content,
      reasoningContent: message.role === 'agent' ? messageThinkingText(message) : undefined,
    })
  }

  return messages
}

function userMessageContent(agent: AgentRow, message: MessageRow): ChatContent | null {
  const text = messageText(message)
  if (!agent.supportsVision) return text

  const images = message.parts
    .filter((part) => part.type === 'image_attachment')
    .map((part) => ({ part, url: attachmentDataUrl(part.attachmentId) }))
    .filter((item): item is { part: Extract<MessagePart, { type: 'image_attachment' }>; url: string } => !!item.url)

  if (images.length === 0) return text

  return [
    {
      type: 'text',
      text: text || `请查看上传的图片：${images.map((image) => image.part.fileName).join(', ')}`,
    },
    ...images.map((image) => ({
      type: 'image_url' as const,
      image_url: { url: image.url },
    })),
  ]
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

function shouldRunDirectScreenshot(bucket: MessageRow[], replyId: string): boolean {
  const trigger = [...bucket].reverse().find((message) => message.id !== replyId && message.role === 'user')
  if (!trigger) return false
  const text = messageText(trigger).trim().toLowerCase()
  if (!text) return false
  if (/^(怎么|为什么|为何).*(截图|截屏)|(?:截图|截屏).*(不行|失败|报错|问题)/.test(text)) {
    return false
  }
  return (
    /^(\/)?\s*(?:(?:帮我|请|给我|麻烦|现在|直接)\s*)?(截图|截屏|屏幕截图|当前屏幕|电脑屏幕|desktop\s*screenshot|screenshot)(?:\s|$|[，。,.!?！？])/.test(text) ||
    (text.length <= 32 && /(截个?屏|截一下屏|截张?图|屏幕截图|当前屏幕|desktop\s*screenshot|screenshot)/.test(text))
  )
}

async function runDirectScreenshot(args: {
  conversation: ConversationWithMeta
  reply: MessageRow
  runId: string
  broadcast: Broadcast
  agent: AgentRow
}): Promise<void> {
  const callId = `call_${Date.now()}_desktop_capture_screen`
  addToolUsePart(args.reply, args.broadcast, callId, 'desktop_capture_screen', {})
  const result = await toolRegistry.execute('desktop_capture_screen', {}, {
    conversation: args.conversation,
    agentId: args.agent.id,
    runId: args.runId,
  })

  const value = result.ok ? result.value : { error: result.error }
  addToolResultPart(args.reply, args.broadcast, callId, value, !result.ok)

  if (!result.ok) {
    const textPartIndex = args.reply.parts.length
    startReplyPart(args.reply, args.broadcast, textPartIndex, { type: 'text', content: '' })
    appendReplyPart(args.reply, textPartIndex, `截图失败：${result.error}`)
    args.broadcast({
      type: 'part.delta',
      conversationId: args.reply.conversationId,
      messageId: args.reply.id,
      partIndex: textPartIndex,
      delta: { type: 'text.append', text: `截图失败：${result.error}` },
      timestamp: Date.now(),
    })
    endPartIfStarted(args.broadcast, args.reply, textPartIndex)
    args.reply.status = 'error'
    finishStreamingReply(args.broadcast, args.runId, args.reply, 'failed', null, args.agent.modelId, result.error)
    return
  }

  args.reply.status = 'complete'
  finishStreamingReply(args.broadcast, args.runId, args.reply, 'complete', null, args.agent.modelId)
}

async function* callChatCompletionStream(
  agent: AgentRow,
  messages: ChatMessage[],
  tools: ToolDef[],
): AsyncIterable<StreamedModelEvent> {
  const needsVision = hasVisionContent(messages)
  const config = chatProviderConfig(agent, { needsVision })
  if (needsVision && config.provider === 'volcano-ark') {
    yield* callArkResponses(agent, config, messages)
    return
  }

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

async function* callArkResponses(
  agent: AgentRow,
  config: ChatProviderConfig,
  messages: ChatMessage[],
): AsyncIterable<StreamedModelEvent> {
  const response = await fetch(`${config.baseUrl.replace(/\/+$/, '')}/responses`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      instructions: agent.systemPrompt,
      input: toResponsesInput(messages),
    }),
  })

  const json = (await response.json().catch(() => null)) as ResponsesApiResponse | null
  if (!response.ok) {
    const detail = json?.error?.message ? `: ${json.error.message}` : ''
    throw new Error(`模型请求失败 (${response.status})${detail}`)
  }

  const text = responsesOutputText(json)
  if (text) yield { type: 'text', text }
  if (json?.usage) {
    yield {
      type: 'usage',
      usage: {
        inputTokens: json.usage.input_tokens ?? 0,
        outputTokens: json.usage.output_tokens ?? 0,
        cacheReadTokens: 0,
      },
    }
  }
  yield { type: 'finish', reason: 'stop' }
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

function toResponsesInput(messages: ChatMessage[]): Array<Record<string, unknown>> {
  return messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => ({
      role: message.role,
      content: toResponsesContent(message.content),
    }))
    .filter((message) => Array.isArray(message.content) && message.content.length > 0)
}

function toResponsesContent(content: ChatContent | null): ResponsesContentPart[] {
  if (!content) return []
  if (typeof content === 'string') {
    return content.trim() ? [{ type: 'input_text', text: content }] : []
  }
  return content
    .map((part): ResponsesContentPart => {
      if (part.type === 'text') return { type: 'input_text', text: part.text }
      return { type: 'input_image', image_url: part.image_url.url }
    })
    .filter((part): part is ResponsesContentPart =>
      part.type === 'input_text' ? Boolean(part.text.trim()) : Boolean(part.image_url),
    )
}

function responsesOutputText(response: ResponsesApiResponse | null): string {
  if (!response) return ''
  if (response.output_text) return response.output_text
  return (response.output ?? [])
    .flatMap((item) => item.content ?? [])
    .map((content) => content.text ?? '')
    .filter(Boolean)
    .join('')
}

function hasVisionContent(messages: ChatMessage[]): boolean {
  return messages.some((message) =>
    Array.isArray(message.content)
      ? message.content.some((part) => part.type === 'image_url')
      : false,
  )
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

function compactModelToolResult(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const record = value as Record<string, unknown>
  if (typeof record.imageDataUrl !== 'string') return value
  const { imageDataUrl: _imageDataUrl, ...rest } = record
  return {
    ...rest,
    note: 'Screenshot captured. The UI displays the image from the tool result; if you mention it in text, use publicUrl or markdown only.',
  }
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

function chatProviderConfig(agent: AgentRow, options: { needsVision?: boolean } = {}): ChatProviderConfig {
  const requestedProvider = agent.modelProvider ?? 'deepseek'
  let provider = options.needsVision ? 'volcano-ark' : requestedProvider
  let useAgentEndpoint = !options.needsVision || requestedProvider === 'volcano-ark'
  let apiKey = useAgentEndpoint ? agent.apiKey?.trim() || providerApiKey(provider) : providerApiKey(provider)

  if (!options.needsVision && !apiKey && provider !== 'volcano-ark' && providerApiKey('volcano-ark')) {
    provider = 'volcano-ark'
    useAgentEndpoint = false
    apiKey = providerApiKey(provider)
  }

  const model = resolveProviderModel(provider, agent, useAgentEndpoint)
  const baseUrl = useAgentEndpoint ? agent.apiBaseUrl?.trim() || providerDefaultBaseUrl(provider) : providerDefaultBaseUrl(provider)
  if (!apiKey) throw new Error(`缺少 ${providerApiKeyName(provider)}，请检查 neros/.env、apps/web/.env.local 或 Agent 配置。`)
  return { provider, baseUrl, apiKey, model }
}

function resolveProviderModel(
  provider: AgentRow['modelProvider'],
  agent: AgentRow,
  useAgentEndpoint: boolean,
): string {
  const agentModel = useAgentEndpoint ? agent.modelId?.trim() : ''
  const model = agentModel || providerDefaultModel(provider)
  if (!model && provider === 'volcano-ark') {
    throw new Error(
      '缺少火山方舟模型 ID。请在 neros/.env 设置 ARK_MODEL=你已开通的方舟模型或 endpoint id。',
    )
  }
  if (provider === 'volcano-ark' && model.startsWith('api-key-')) {
    throw new Error(
      `火山方舟模型 ID 不能填 API Key 名称 ${model}。请在方舟控制台复制已开通模型的 endpoint id，通常类似 ep-...，然后写入 ARK_MODEL。`,
    )
  }
  if (!model) throw new Error(`缺少 ${providerLabel(provider)} 模型 ID。`)
  return model
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
      return envValue('OPENAI_MODEL') || 'gpt-4o'
    case 'volcano-ark':
      return (
        envValue('ARK_MODEL') ||
        envValue('ARK_MODEL_ID') ||
        envValue('ARK_ENDPOINT_ID') ||
        envValue('VOLCANO_ARK_MODEL') ||
        envValue('VOLCANO_ARK_MODEL_ID') ||
        envValue('VOLCANO_ARK_ENDPOINT_ID') ||
        envValue('NEROS_MODEL')
      )
    case 'anthropic':
      return envValue('ANTHROPIC_MODEL') || 'claude-opus-4-7'
    case 'deepseek':
    default:
      return envValue('DEEPSEEK_MODEL') || envValue('NEROS_MODEL') || 'deepseek-v4-flash'
  }
}

function providerApiKey(provider: AgentRow['modelProvider']): string {
  switch (provider) {
    case 'openai':
    case 'openai-compatible':
      return envValue('OPENAI_API_KEY')
    case 'volcano-ark':
      return envValue('ARK_API_KEY')
    case 'anthropic':
      return envValue('ANTHROPIC_API_KEY')
    case 'deepseek':
    default:
      return envValue('DEEPSEEK_API_KEY') || envValue('NEROS_API_KEY')
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

function providerLabel(provider: AgentRow['modelProvider']): string {
  switch (provider) {
    case 'openai':
      return 'OpenAI'
    case 'openai-compatible':
      return 'OpenAI-compatible'
    case 'volcano-ark':
      return '火山方舟'
    case 'anthropic':
      return 'Anthropic'
    case 'deepseek':
    default:
      return 'DeepSeek'
  }
}

function renderAgentError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return `Neros 暂时没能完成回复：${message}`
}

function envValue(name: string): string {
  return process.env[name]?.trim() || envFileValues()[name]?.trim() || ''
}

function envFileValues(): Record<string, string> {
  const values: Record<string, string> = {}
  for (const filePath of envFileCandidates()) {
    if (!existsSync(filePath)) continue
    Object.assign(values, parseEnvFile(readFileSync(filePath, 'utf8')))
  }
  return values
}

function envFileCandidates(): string[] {
  return [
    path.resolve(process.cwd(), '.env.local'),
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), '../../.env.local'),
    path.resolve(process.cwd(), '../../.env'),
  ]
}

function parseEnvFile(content: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const index = line.indexOf('=')
    if (index <= 0) continue
    const key = line.slice(0, index).trim()
    const rawValue = line.slice(index + 1).trim()
    values[key] = stripEnvQuotes(rawValue)
  }
  return values
}

function stripEnvQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }
  return value
}
