import { createArtifact, findArtifact } from '@/server/artifact-store'
import { buildArtifactContent, describeArtifactContentError } from '@/server/artifact-content'
import type { ArtifactType } from '@/shared/types'

import type { ToolDef } from './types'

const WRITABLE_TYPES = new Set(['web_app', 'document', 'image', 'ppt', 'diagram'])

export const writeArtifactTool: ToolDef = {
  name: 'write_artifact',
  description:
    'Create a previewable artifact. Required args: type, title, content. Supported types: web_app, document, image, ppt, diagram.',
  parameters: {
    type: 'object',
    required: ['type', 'title', 'content'],
    properties: {
      type: {
        type: 'string',
        enum: ['web_app', 'document', 'image', 'ppt', 'diagram'],
        description: 'Artifact type.',
      },
      title: { type: 'string', description: 'Short human-readable title.' },
      content: {
        type: 'object',
        description:
          'For web_app use { files: { "index.html": "...", "style.css": "...", "script.js": "..." }, entry: "index.html" }. For document use { content: "markdown" }. For diagram use { source: "flowchart TD..." }. For image use { url, alt }. For ppt use { slides: [...] }.',
      },
      parentArtifactId: { type: 'string', description: 'Optional parent artifact id for a new version.' },
    },
  },
  async handler(args, ctx) {
    const input = args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {}
    const type = typeof input.type === 'string' && WRITABLE_TYPES.has(input.type) ? (input.type as ArtifactType) : null
    const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim() : null
    const parentArtifactId = typeof input.parentArtifactId === 'string' ? input.parentArtifactId : null

    if (!type) return { ok: false, error: 'type is required and must be one of web_app, document, image, ppt, diagram' }
    if (!title) return { ok: false, error: 'title is required' }
    if (!('content' in input)) return { ok: false, error: 'content is required' }

    if (parentArtifactId) {
      const parent = findArtifact(parentArtifactId)
      if (!parent) return { ok: false, error: `parentArtifactId not found: ${parentArtifactId}` }
      if (parent.conversationId !== ctx.conversation.id) {
        return { ok: false, error: 'parentArtifactId belongs to a different conversation' }
      }
    }

    const content = buildArtifactContent(type, input.content)
    if (!content) return { ok: false, error: describeArtifactContentError(type) }

    const artifact = createArtifact({
      conversationId: ctx.conversation.id,
      type,
      title,
      content,
      parentArtifactId,
      createdByAgentId: ctx.agentId,
    })

    return {
      ok: true,
      value: {
        artifactId: artifact.id,
        title: artifact.title,
        type: artifact.type,
        version: artifact.version,
        parentArtifactId: artifact.parentArtifactId,
        artifact,
      },
    }
  },
}
