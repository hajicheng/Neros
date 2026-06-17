import type { ArtifactRow, ConversationWithMeta } from '@/db/schema'
import { sqlite } from '@/db/client'
import type { ArtifactContent, ArtifactType } from '@/shared/types'

type ArtifactListItem = Omit<ArtifactRow, 'content'> & {
  conversationTitle: string | null
}

type ArtifactDbRow = {
  id: string
  conversation_id: string
  type: string
  title: string
  content: string
  version: number
  parent_artifact_id: string | null
  created_by_agent_id: string
  created_at: number
}

export function createArtifact(args: {
  conversationId: string
  type: ArtifactType
  title: string
  content: ArtifactContent
  parentArtifactId?: string | null
  createdByAgentId: string
}): ArtifactRow {
  const parent = args.parentArtifactId ? findArtifact(args.parentArtifactId) : null
  const artifact: ArtifactRow = {
    id: `art_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    conversationId: args.conversationId,
    type: args.type,
    title: args.title,
    content: args.content,
    version: parent ? parent.version + 1 : 1,
    parentArtifactId: parent?.id ?? null,
    createdByAgentId: args.createdByAgentId,
    createdAt: Date.now(),
  }
  sqlite
    .prepare(
      `INSERT INTO artifacts (
        id, conversation_id, type, title, content, version,
        parent_artifact_id, created_by_agent_id, created_at
      ) VALUES (
        @id, @conversation_id, @type, @title, @content, @version,
        @parent_artifact_id, @created_by_agent_id, @created_at
      )`,
    )
    .run(toDbParams(artifact))
  return artifact
}

export function createArtifactVersion(args: {
  parentArtifactId: string
  title?: string
  content: ArtifactContent
}): ArtifactRow | null {
  const parent = findArtifact(args.parentArtifactId)
  if (!parent) return null
  return createArtifact({
    conversationId: parent.conversationId,
    type: parent.type,
    title: args.title?.trim() || parent.title,
    content: args.content,
    parentArtifactId: parent.id,
    createdByAgentId: parent.createdByAgentId,
  })
}

export function findArtifact(artifactId: string): ArtifactRow | undefined {
  const row = sqlite
    .prepare(
      `SELECT
        id, conversation_id, type, title, content, version,
        parent_artifact_id, created_by_agent_id, created_at
      FROM artifacts
      WHERE id = ?`,
    )
    .get(artifactId) as ArtifactDbRow | undefined
  return row ? fromDbRow(row) : undefined
}

export function listArtifacts(conversations: ConversationWithMeta[]): ArtifactListItem[] {
  const rows = sqlite
    .prepare(
      `SELECT
        id, conversation_id, type, title, content, version,
        parent_artifact_id, created_by_agent_id, created_at
      FROM artifacts
      ORDER BY created_at DESC`,
    )
    .all() as ArtifactDbRow[]

  return rows
    .map(fromDbRow)
    .map((artifact) => {
      const { content: _content, ...item } = artifact
      return {
        ...item,
        conversationTitle: conversations.find((conversation) => conversation.id === artifact.conversationId)?.title ?? null,
      }
    })
}

export function listArtifactVersions(artifactId: string): ArtifactRow[] {
  const root = findArtifactRootId(artifactId)
  if (!root) return []
  const rows = sqlite
    .prepare(
      `SELECT
        id, conversation_id, type, title, content, version,
        parent_artifact_id, created_by_agent_id, created_at
      FROM artifacts`,
    )
    .all() as ArtifactDbRow[]

  return rows
    .map(fromDbRow)
    .filter((artifact) => findArtifactRootId(artifact.id) === root)
    .sort((a, b) => a.version - b.version)
}

export function deleteArtifact(artifactId: string): boolean {
  const result = sqlite.prepare('DELETE FROM artifacts WHERE id = ?').run(artifactId)
  return result.changes > 0
}

function findArtifactRootId(artifactId: string): string | null {
  let current = findArtifact(artifactId)
  if (!current) return null
  while (current.parentArtifactId) {
    const parent = findArtifact(current.parentArtifactId)
    if (!parent) break
    current = parent
  }
  return current.id
}

function fromDbRow(row: ArtifactDbRow): ArtifactRow {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    type: row.type as ArtifactType,
    title: row.title,
    content: jsonContent(row.content),
    version: row.version,
    parentArtifactId: row.parent_artifact_id,
    createdByAgentId: row.created_by_agent_id,
    createdAt: row.created_at,
  }
}

function toDbParams(artifact: ArtifactRow) {
  return {
    id: artifact.id,
    conversation_id: artifact.conversationId,
    type: artifact.type,
    title: artifact.title,
    content: JSON.stringify(artifact.content),
    version: artifact.version,
    parent_artifact_id: artifact.parentArtifactId,
    created_by_agent_id: artifact.createdByAgentId,
    created_at: artifact.createdAt,
  }
}

function jsonContent(value: string): ArtifactContent {
  return JSON.parse(value) as ArtifactContent
}
