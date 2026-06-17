import { readWorkspaceFile, writeWorkspaceFile } from '@/server/workspace-service'
import type { ConversationWithMeta } from '@/db/schema'
import type { PendingWrite } from '@/shared/types'

import { broadcastEvent } from './event-stream'

type PendingWriteDecision =
  | { applied: true; result: unknown }
  | { applied: false; error: string }

type PendingEntry = {
  write: PendingWrite
  conversation: ConversationWithMeta
  resolver: ((decision: PendingWriteDecision) => void) | null
}

class PendingWritesStore {
  private map = new Map<string, PendingEntry>()

  register(args: {
    conversation: ConversationWithMeta
    agentId: string
    runId: string
    path: string
    absolutePath: string
    oldContent: string | null
    newContent: string
  }): PendingWrite {
    const write: PendingWrite = {
      id: `pwr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      conversationId: args.conversation.id,
      agentId: args.agentId,
      runId: args.runId,
      path: args.path,
      absolutePath: args.absolutePath,
      oldContent: args.oldContent,
      newContent: args.newContent,
      createdAt: Date.now(),
    }

    this.map.set(write.id, {
      write,
      conversation: args.conversation,
      resolver: null,
    })

    broadcastEvent({
      type: 'fs_write.pending',
      conversationId: write.conversationId,
      pendingWrite: write,
      timestamp: write.createdAt,
    })

    return write
  }

  attachResolver(id: string, resolver: (decision: PendingWriteDecision) => void): void {
    const entry = this.map.get(id)
    if (entry) entry.resolver = resolver
  }

  listByConversation(conversationId: string): PendingWrite[] {
    return Array.from(this.map.values())
      .filter((entry) => entry.write.conversationId === conversationId)
      .map((entry) => entry.write)
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  approve(id: string): boolean {
    const entry = this.map.get(id)
    if (!entry) return false

    try {
      const result = writeWorkspaceFile(entry.conversation, entry.write.path, entry.write.newContent)
      this.finalize(id, { applied: true, result: { ...result, applied: 'review' } })
      return true
    } catch (err) {
      this.finalize(id, {
        applied: false,
        error: err instanceof Error ? err.message : String(err),
      })
      return true
    }
  }

  reject(id: string): boolean {
    if (!this.map.has(id)) return false
    this.finalize(id, { applied: false, error: 'User rejected the file change' })
    return true
  }

  cancel(id: string): void {
    if (!this.map.has(id)) return
    this.finalize(id, { applied: false, error: 'File change was cancelled' })
  }

  private finalize(id: string, decision: PendingWriteDecision): void {
    const entry = this.map.get(id)
    if (!entry) return
    entry.resolver?.(decision)
    this.map.delete(id)
    broadcastEvent({
      type: 'fs_write.resolved',
      conversationId: entry.write.conversationId,
      pendingId: id,
      applied: decision.applied,
      timestamp: Date.now(),
    })
  }
}

const globalForPendingWrites = globalThis as unknown as {
  __nerosPendingWrites?: PendingWritesStore
}

export const pendingWrites = globalForPendingWrites.__nerosPendingWrites ?? new PendingWritesStore()

if (!globalForPendingWrites.__nerosPendingWrites) {
  globalForPendingWrites.__nerosPendingWrites = pendingWrites
}

export function readWorkspaceFileIfExists(
  conversation: ConversationWithMeta,
  relPath: string,
): string | null {
  try {
    return readWorkspaceFile(conversation, relPath).content
  } catch {
    return null
  }
}
