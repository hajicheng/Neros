import type { PendingBashCommand } from '@/shared/types'

import { broadcastEvent } from './event-stream'

type PendingBashDecision = { approved: boolean }

type PendingEntry = {
  command: PendingBashCommand
  resolver: ((decision: PendingBashDecision) => void) | null
}

class PendingBashCommandsStore {
  private map = new Map<string, PendingEntry>()

  register(args: {
    conversationId: string
    agentId: string
    runId: string
    command: string
    cwd: string
    reason: string
  }): PendingBashCommand {
    const command: PendingBashCommand = {
      id: `pbc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      conversationId: args.conversationId,
      agentId: args.agentId,
      runId: args.runId,
      command: args.command,
      cwd: args.cwd,
      reason: args.reason,
      createdAt: Date.now(),
    }

    this.map.set(command.id, { command, resolver: null })
    broadcastEvent({
      type: 'bash_command.pending',
      conversationId: args.conversationId,
      pendingCommand: command,
      timestamp: command.createdAt,
    })
    return command
  }

  attachResolver(id: string, resolver: (decision: PendingBashDecision) => void): void {
    const entry = this.map.get(id)
    if (entry) entry.resolver = resolver
  }

  listByConversation(conversationId: string): PendingBashCommand[] {
    return Array.from(this.map.values())
      .filter((entry) => entry.command.conversationId === conversationId)
      .map((entry) => entry.command)
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  approve(id: string): boolean {
    if (!this.map.has(id)) return false
    this.finalize(id, { approved: true })
    return true
  }

  reject(id: string): boolean {
    if (!this.map.has(id)) return false
    this.finalize(id, { approved: false })
    return true
  }

  cancel(id: string): void {
    if (!this.map.has(id)) return
    this.finalize(id, { approved: false })
  }

  private finalize(id: string, decision: PendingBashDecision): void {
    const entry = this.map.get(id)
    if (!entry) return
    entry.resolver?.(decision)
    this.map.delete(id)
    broadcastEvent({
      type: 'bash_command.resolved',
      conversationId: entry.command.conversationId,
      pendingId: id,
      approved: decision.approved,
      timestamp: Date.now(),
    })
  }
}

const globalForPendingBash = globalThis as unknown as {
  __nerosPendingBashCommands?: PendingBashCommandsStore
}

export const pendingBashCommands =
  globalForPendingBash.__nerosPendingBashCommands ?? new PendingBashCommandsStore()

if (!globalForPendingBash.__nerosPendingBashCommands) {
  globalForPendingBash.__nerosPendingBashCommands = pendingBashCommands
}
