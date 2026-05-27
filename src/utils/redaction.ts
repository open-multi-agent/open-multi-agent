const REDACTED = '[redacted]'

const SENSITIVE_NAME_PATTERN =
  /(?:api[_-]?key|apiKey|secret|password|passwd|pwd|private[_-]?key|privateKey|access[_-]?key|accessKey|accessToken|refreshToken|idToken|githubToken|authorization|auth[_-]?token|authToken|cookie|session|credential|bearer|^token$|[_-]token$|^token[_-])/i

// Quoted value: matches `key: "value with spaces"` or `key='value with spaces'`
// (lazy `[^]*?` + back-referenced closing quote handles spaces and inner quotes
// of the opposite kind; escaped same-kind quotes are not handled by design.)
const QUOTED_ASSIGNMENT_PATTERN =
  /(["']?)([A-Za-z_][A-Za-z0-9_.-]*)(\1?\s*[:=]\s*)(["'])([^]*?)\4/g

// Unquoted value: matches `key=value` where value may include spaces and
// runs until a structural delimiter (`,`, `;`, `}`, `]`, newline) or EOL.
// Must run AFTER the quoted pass so already-redacted quoted values
// (`password="[redacted]"`) aren't matched here.
const UNQUOTED_ASSIGNMENT_PATTERN =
  /(["']?)([A-Za-z_][A-Za-z0-9_.-]*)(\1?\s*[:=]\s*)([^"'\s,;}\]\n\r][^,;}\]\n\r]*)/g

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

  // Pass 1: quoted values. Consume to matching closing quote so values
  // containing spaces (`password="my pass"`) are fully redacted rather than
  // partially leaked at the first whitespace.
  redacted = redacted.replace(
    QUOTED_ASSIGNMENT_PATTERN,
    (
      match: string,
      keyQuote: string,
      key: string,
      separator: string,
      valueQuote: string,
      _value: string,
    ) => {
      if (!isSensitiveName(key)) return match
      return `${keyQuote}${key}${separator}${valueQuote}${REDACTED}${valueQuote}`
    },
  )

  // Pass 2: unquoted values. Consume to the next structural delimiter so
  // values with internal whitespace (`password=my pass`) are fully redacted.
  redacted = redacted.replace(
    UNQUOTED_ASSIGNMENT_PATTERN,
    (
      match: string,
      keyQuote: string,
      key: string,
      separator: string,
      value: string,
    ) => {
      if (!isSensitiveName(key)) return match
      // Skip already-redacted values from an earlier pass (e.g. the
      // Authorization rule emits `[redacted]`; the value char class stops
      // at `]`, so we capture `[redacted` and would otherwise re-emit it
      // and leave an orphan `]` behind).
      if (value === '[redacted' || value.startsWith('[redacted')) return match
      return `${keyQuote}${key}${separator}${REDACTED}`
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
