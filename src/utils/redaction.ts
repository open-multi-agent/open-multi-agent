const REDACTED = '[redacted]'

const SENSITIVE_NAME_PATTERN =
  /(?:api[_-]?key|apiKey|secret|password|passwd|pwd|private[_-]?key|privateKey|access[_-]?key|accessKey|accessToken|refreshToken|idToken|githubToken|authorization|auth[_-]?token|authToken|cookie|session|credential|bearer|^token$|[_-]token$|^token[_-])/i

const ASSIGNMENT_PATTERN =
  /(["']?)([A-Za-z_][A-Za-z0-9_.-]*)(["']?\s*[:=]\s*)(["']?)([^"',\s}\]]+)(["']?)/g

const TOKEN_LITERAL_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
]

export function isSensitiveName(name: string): boolean {
  return SENSITIVE_NAME_PATTERN.test(name)
}

export function redactSensitiveText(text: string): string {
  if (text.length === 0) return text

  let redacted = text.replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    REDACTED,
  )

  redacted = redacted.replace(
    /\b(Authorization\s*:\s*)(?:Bearer\s+)?[^\n\r,;}]+/gi,
    `$1${REDACTED}`,
  )

  redacted = redacted.replace(
    /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    `Bearer ${REDACTED}`,
  )

  redacted = redacted.replace(
    ASSIGNMENT_PATTERN,
    (
      match: string,
      keyQuote: string,
      key: string,
      separator: string,
      valueQuote: string,
      value: string,
      closeQuote: string,
    ) => {
      if (!isSensitiveName(key)) return match
      // Value char class stops at `]`, so an earlier pass that emitted
      // `[redacted]` (e.g. the Authorization rule) would be re-matched as
      // `[redacted` and re-emitted, leaving an orphan `]` behind. Bail out
      // when the value already looks redacted.
      if (value === '[redacted') return match
      return `${keyQuote}${key}${separator}${valueQuote}${REDACTED}${closeQuote || valueQuote}`
    },
  )

  for (const pattern of TOKEN_LITERAL_PATTERNS) {
    redacted = redacted.replace(pattern, REDACTED)
  }

  return redacted
}

export function redactSensitiveObject<T>(value: T): T {
  return redactValue(value) as T
}

function redactValue(value: unknown, key?: string): unknown {
  if (key !== undefined && isSensitiveName(key)) {
    return REDACTED
  }

  if (typeof value === 'string') {
    return redactSensitiveText(value)
  }

  if (Array.isArray(value)) {
    return value.map(item => redactValue(item))
  }

  if (value !== null && typeof value === 'object') {
    if (value instanceof Date) return value

    const redacted: Record<string, unknown> = {}
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      redacted[childKey] = redactValue(childValue, childKey)
    }
    return redacted
  }

  return value
}
