export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

export function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}
