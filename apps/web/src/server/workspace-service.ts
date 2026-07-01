import { exec as execCallback } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

import { DATA_DIR } from '@/db/client'
import type { ConversationWithMeta } from '@/db/schema'

const exec = promisify(execCallback)
const MAX_FILE_CHARS = 50_000

export type ListDirResult = {
  path?: string
  relPath?: string
  absolutePath: string
  parent: string | null
  entries: Array<{ name: string; isDirectory: boolean; size?: number }>
}

export function listHostDirectory(targetPath: string): ListDirResult {
  const absolutePath = path.resolve(targetPath || process.cwd())
  const entries = readdirSync(absolutePath, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith('.DS_Store'))
    .map((entry) => {
      const fullPath = path.join(absolutePath, entry.name)
      const stat = statSync(fullPath)
      return {
        name: entry.name,
        isDirectory: entry.isDirectory(),
        size: entry.isDirectory() ? undefined : stat.size,
      }
    })
    .sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name))

  return {
    path: absolutePath,
    absolutePath,
    parent: path.dirname(absolutePath) === absolutePath ? null : path.dirname(absolutePath),
    entries,
  }
}

export function listWorkspaceDirectory(conversation: ConversationWithMeta, relPath = ''): ListDirResult {
  const root = workspaceRoot(conversation)
  const absolutePath = safeWorkspacePath(conversation, relPath)
  const entries = readdirSync(absolutePath, { withFileTypes: true })
    .filter((entry) => entry.name !== '.DS_Store')
    .map((entry) => {
      const fullPath = path.join(absolutePath, entry.name)
      const stat = statSync(fullPath)
      return {
        name: entry.name,
        isDirectory: entry.isDirectory(),
        size: entry.isDirectory() ? undefined : stat.size,
      }
    })
    .sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name))

  const normalizedRel = normalizeRelPath(path.relative(root, absolutePath))
  const parent = normalizedRel ? normalizeRelPath(path.dirname(normalizedRel)) : null
  return { relPath: normalizedRel, absolutePath, parent: parent === '.' ? '' : parent, entries }
}

export function readWorkspaceFile(conversation: ConversationWithMeta, relPath: string) {
  const absolutePath = safeWorkspacePath(conversation, relPath)
  const stat = statSync(absolutePath)
  const raw = readFileSync(absolutePath, 'utf8')
  const truncated = raw.length > MAX_FILE_CHARS
  return {
    path: normalizeRelPath(relPath),
    absolutePath,
    cwd: workspaceRoot(conversation),
    size: stat.size,
    content: truncated ? raw.slice(0, MAX_FILE_CHARS) : raw,
    truncated,
  }
}

export function readWorkspaceBinaryFile(conversation: ConversationWithMeta, relPath: string) {
  const absolutePath = safeWorkspacePath(conversation, relPath)
  const stat = statSync(absolutePath)
  return {
    path: normalizeRelPath(relPath),
    absolutePath,
    size: stat.size,
    bytes: readFileSync(absolutePath),
  }
}

export function writeWorkspaceFile(conversation: ConversationWithMeta, relPath: string, content: string) {
  const absolutePath = safeWorkspacePath(conversation, relPath)
  mkdirSync(path.dirname(absolutePath), { recursive: true })
  writeFileSync(absolutePath, content, 'utf8')
  return {
    path: normalizeRelPath(relPath),
    absolutePath,
    cwd: workspaceRoot(conversation),
    bytes: Buffer.byteLength(content, 'utf8'),
  }
}

export function resolveWorkspacePath(conversation: ConversationWithMeta, relPath: string): string {
  return safeWorkspacePath(conversation, relPath)
}

export async function runWorkspaceCommand(
  conversation: ConversationWithMeta,
  command: string,
  cwd = '',
  timeoutMs = 120_000,
) {
  const root = workspaceRoot(conversation)
  const commandCwd = cwd ? safeWorkspacePath(conversation, cwd) : root
  const startedAt = Date.now()
  try {
    const result = await exec(command, {
      cwd: commandCwd,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/zsh',
    })
    return {
      command,
      cwd: commandCwd,
      exitCode: 0,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: Date.now() - startedAt,
    }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number | string; signal?: string }
    return {
      command,
      cwd: commandCwd,
      exitCode: typeof e.code === 'number' ? e.code : null,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? (err instanceof Error ? err.message : String(err)),
      signal: e.signal,
      durationMs: Date.now() - startedAt,
    }
  }
}

export function workspaceRoot(conversation: ConversationWithMeta): string {
  if (conversation.workspaceMode === 'local' && conversation.workspaceBoundPath) {
    return path.resolve(conversation.workspaceBoundPath)
  }
  const root = path.join(DATA_DIR, 'workspaces', conversation.id)
  mkdirSync(root, { recursive: true })
  return root
}

function safeWorkspacePath(conversation: ConversationWithMeta, target: string): string {
  const root = workspaceRoot(conversation)
  const absolutePath = path.resolve(root, target || '.')
  const relative = path.relative(root, absolutePath)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path escapes workspace: ${target}`)
  }
  return absolutePath
}

function normalizeRelPath(value: string): string {
  return value.replaceAll(path.sep, '/').replace(/^\.$/, '')
}
