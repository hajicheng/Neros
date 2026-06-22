import type { AttachmentRow } from '@/db/schema'

type StoredAttachment = {
  row: AttachmentRow
  bytes: Buffer
}

const attachmentsById = new Map<string, StoredAttachment>()
const attachmentIdsByConversation = new Map<string, string[]>()

export function listAttachments(conversationId: string): AttachmentRow[] {
  return (attachmentIdsByConversation.get(conversationId) ?? [])
    .map((id) => attachmentsById.get(id)?.row)
    .filter((row): row is AttachmentRow => !!row)
}

export function createAttachment(args: {
  conversationId: string
  fileName: string
  mimeType: string
  bytes: Buffer
}): AttachmentRow {
  const id = `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const mimeType = args.mimeType || 'application/octet-stream'
  const row: AttachmentRow = {
    id,
    conversationId: args.conversationId,
    kind: mimeType.startsWith('image/') ? 'image' : 'file',
    fileName: args.fileName || 'attachment',
    filePath: `memory://${id}`,
    size: args.bytes.byteLength,
    mimeType,
    createdAt: Date.now(),
  }

  attachmentsById.set(id, { row, bytes: args.bytes })
  const ids = attachmentIdsByConversation.get(args.conversationId) ?? []
  ids.push(id)
  attachmentIdsByConversation.set(args.conversationId, ids)
  return row
}

export function findAttachment(id: string): StoredAttachment | null {
  return attachmentsById.get(id) ?? null
}

export function resolveAttachments(conversationId: string, ids: string[]): AttachmentRow[] {
  const allowed = new Set(attachmentIdsByConversation.get(conversationId) ?? [])
  return ids
    .filter((id) => allowed.has(id))
    .map((id) => attachmentsById.get(id)?.row)
    .filter((row): row is AttachmentRow => !!row)
}

export function attachmentDataUrl(id: string): string | null {
  const item = attachmentsById.get(id)
  if (!item) return null
  return `data:${item.row.mimeType};base64,${item.bytes.toString('base64')}`
}

export function deleteAttachment(id: string): boolean {
  const item = attachmentsById.get(id)
  if (!item) return false
  attachmentsById.delete(id)
  const ids = attachmentIdsByConversation.get(item.row.conversationId) ?? []
  const next = ids.filter((candidate) => candidate !== id)
  if (next.length > 0) attachmentIdsByConversation.set(item.row.conversationId, next)
  else attachmentIdsByConversation.delete(item.row.conversationId)
  return true
}
