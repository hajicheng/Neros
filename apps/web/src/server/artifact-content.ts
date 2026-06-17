import { normaliseMermaidSource } from '@/shared/mermaid-normalize'
import { normalizeBlocks } from '@/shared/ppt-normalize'
import type { ArtifactContent, ArtifactType, MermaidTheme, PptSlide, PptTheme } from '@/shared/types'

export function buildArtifactContent(type: ArtifactType, rawInput: unknown): ArtifactContent | null {
  const raw = unwrapStringifiedContent(rawInput)

  if (type === 'web_app') {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const obj = raw as Record<string, unknown>
      if (obj.files && typeof obj.files === 'object' && !Array.isArray(obj.files)) {
        const files: Record<string, string> = {}
        for (const [name, content] of Object.entries(obj.files)) {
          if (typeof content === 'string') files[name] = content
        }
        if (Object.keys(files).length === 0) return null
        return { type: 'web_app', files, entry: readString(obj.entry) ?? 'index.html' }
      }
      const files: Record<string, string> = {}
      if (typeof obj.html === 'string') files['index.html'] = obj.html
      if (typeof obj.css === 'string') files['style.css'] = obj.css
      if (typeof obj.js === 'string') files['script.js'] = obj.js
      if (Object.keys(files).length > 0) return { type: 'web_app', files, entry: 'index.html' }
      if (typeof obj.content === 'string') {
        return { type: 'web_app', files: { 'index.html': obj.content }, entry: 'index.html' }
      }
    }
    if (typeof raw === 'string') return { type: 'web_app', files: { 'index.html': raw }, entry: 'index.html' }
    return null
  }

  if (type === 'document') {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const obj = raw as Record<string, unknown>
      const content = readString(obj.content) ?? readString(obj.markdown) ?? readString(obj.text)
      if (content !== null) return { type: 'document', format: 'markdown', content }
    }
    if (typeof raw === 'string') return { type: 'document', format: 'markdown', content: raw }
    return null
  }

  if (type === 'image') {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const obj = raw as Record<string, unknown>
      const url = readString(obj.url)
      if (url) return { type: 'image', url, alt: readString(obj.alt) ?? '' }
    }
    if (typeof raw === 'string') return { type: 'image', url: raw, alt: '' }
    return null
  }

  if (type === 'diagram') {
    const source =
      raw && typeof raw === 'object' && !Array.isArray(raw)
        ? readString((raw as Record<string, unknown>).source) ??
          readString((raw as Record<string, unknown>).mermaid) ??
          readString((raw as Record<string, unknown>).content)
        : typeof raw === 'string'
          ? raw
          : null
    if (!source) return null
    const result = normaliseMermaidSource(source)
    if (!result.ok) return null
    return {
      type: 'diagram',
      syntax: 'mermaid',
      source: result.source,
      ...(raw && typeof raw === 'object' && !Array.isArray(raw)
        ? normalizeMermaidTheme((raw as Record<string, unknown>).theme)
        : {}),
    }
  }

  if (type === 'ppt') {
    const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null
    const rawSlides = Array.isArray(raw) ? raw : Array.isArray(obj?.slides) ? obj.slides : null
    if (!rawSlides) return null

    const slides: PptSlide[] = rawSlides
      .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item))
      .map((slide) => {
        const bullets = Array.isArray(slide.bullets)
          ? slide.bullets.filter((item): item is string => typeof item === 'string')
          : undefined
        return {
          ...(readString(slide.title) ? { title: readString(slide.title)! } : {}),
          ...(readString(slide.subtitle) ? { subtitle: readString(slide.subtitle)! } : {}),
          ...(bullets && bullets.length > 0 ? { bullets } : {}),
          ...(normalizeBlocks(slide.blocks).length > 0 ? { blocks: normalizeBlocks(slide.blocks) } : {}),
          ...(readString(slide.notes) ? { notes: readString(slide.notes)! } : {}),
        }
      })
      .filter((slide) => slide.title || slide.subtitle || slide.bullets?.length || slide.blocks?.length || slide.notes)

    if (slides.length === 0) return null
    return {
      type: 'ppt',
      ...(obj && readString(obj.title) ? { title: readString(obj.title)! } : {}),
      ...(obj ? normalizePptTheme(obj.theme) : {}),
      slides,
    }
  }

  return null
}

export function describeArtifactContentError(type: ArtifactType): string {
  return `Invalid content for artifact type ${type}`
}

function unwrapStringifiedContent(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  const trimmed = raw.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return raw
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return raw
  }
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function normalizeMermaidTheme(value: unknown): { theme?: MermaidTheme } {
  return value === 'default' || value === 'base' || value === 'dark' || value === 'forest' || value === 'neutral'
    ? { theme: value }
    : {}
}

function normalizePptTheme(value: unknown): { theme?: PptTheme } {
  return value && typeof value === 'object' && !Array.isArray(value) ? { theme: value as PptTheme } : {}
}
