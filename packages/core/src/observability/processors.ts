import type { TraceAttributeValue } from '../types.js'
import { redactSensitiveText } from '../utils/redaction.js'
import type { TraceRecord } from './records.js'
import type {
  FlushOptions,
  FlushResult,
  TraceCapturePolicy,
  TraceSink,
  TraceSinkStats,
} from './sink.js'
import { emptyTraceSinkStats } from './sink.js'

export type TraceFilter = (record: TraceRecord) => boolean

abstract class DelegatingSink implements TraceSink {
  constructor(protected readonly sink: TraceSink) {}
  abstract emit(record: TraceRecord): void
  forceFlush(options?: FlushOptions): Promise<FlushResult> { return this.sink.forceFlush(options) }
  shutdown(options?: FlushOptions): Promise<FlushResult> { return this.sink.shutdown(options) }
  getStats(): TraceSinkStats { return this.sink.getStats?.() ?? emptyTraceSinkStats() }
}

/** Synchronous record filter. Predicate failures drop telemetry, never business work. */
export class FilteringSink extends DelegatingSink {
  constructor(sink: TraceSink, private readonly filter: TraceFilter) { super(sink) }
  emit(record: TraceRecord): void {
    try {
      if (this.filter(record)) this.sink.emit(record)
    } catch {
      // User filters are telemetry code and must remain isolated.
    }
  }
}

export interface SensitiveDataProcessorOptions {
  /** Optional exact allowlist applied before structural secret removal. */
  readonly attributeAllowlist?: readonly string[]
  readonly capture?: TraceCapturePolicy
}

const STRUCTURED_SECRET = /(^|[._-])(authorization|cookie|set_cookie|api[_-]?key|password|passwd|secret|access[_-]?token|refresh[_-]?token|private[_-]?key)($|[._-])/i
const REASONING_CONTENT = /(^|[._-])(reasoning|thinking|chain[_-]?of[_-]?thought|signed[_-]?reasoning)[._-](content|text|data)($|[._-])/i

function contentKind(key: string): 'prompt' | 'completion' | 'toolInput' | 'toolOutput' | undefined {
  const normal = key.toLowerCase().replaceAll('-', '_')
  if (normal.includes('prompt')) return 'prompt'
  if (normal.includes('completion')) return 'completion'
  if (normal.includes('tool.input') || normal.includes('tool_input') || normal.includes('tool.arguments')) return 'toolInput'
  if (normal.includes('tool.output') || normal.includes('tool_output') || normal.includes('tool.result')) return 'toolOutput'
  return undefined
}

function safeValue(value: TraceAttributeValue, maxChars: number): TraceAttributeValue {
  if (typeof value === 'string') return redactSensitiveText(value).slice(0, maxChars)
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value.map((item) => redactSensitiveText(item).slice(0, maxChars))
  }
  return value
}

/**
 * Structured privacy boundary: allowlist, credential removal, redaction, then
 * truncation. Reasoning content is always removed and has no opt-in.
 */
export class SensitiveDataProcessor extends DelegatingSink {
  private readonly allowlist?: ReadonlySet<string>
  private readonly capture: Required<Pick<TraceCapturePolicy,
    'prompt' | 'completion' | 'toolInput' | 'toolOutput' | 'errorMessage' | 'stack' | 'streamEvents' | 'maxContentChars'>>

  constructor(sink: TraceSink, options: SensitiveDataProcessorOptions = {}) {
    super(sink)
    this.allowlist = options.attributeAllowlist
      ? new Set(options.attributeAllowlist)
      : undefined
    this.capture = {
      prompt: options.capture?.prompt ?? 'none',
      completion: options.capture?.completion ?? 'none',
      toolInput: options.capture?.toolInput ?? 'none',
      toolOutput: options.capture?.toolOutput ?? 'none',
      errorMessage: options.capture?.errorMessage ?? 'redacted',
      stack: options.capture?.stack ?? false,
      streamEvents: options.capture?.streamEvents ?? 'first',
      maxContentChars: options.capture?.maxContentChars ?? 4_096,
    }
  }

  emit(record: TraceRecord): void {
    const attributes: Record<string, TraceAttributeValue> = {}
    for (const [key, value] of Object.entries(record.attributes)) {
      if (this.allowlist && !this.allowlist.has(key)) continue
      if (STRUCTURED_SECRET.test(key) || REASONING_CONTENT.test(key)) continue
      const kind = contentKind(key)
      if (kind && this.capture[kind] === 'none') continue
      attributes[key] = safeValue(value, this.capture.maxContentChars)
    }

    if (record.recordType === 'span_event') {
      if (record.name === 'stream_chunk' && this.capture.streamEvents === 'none') return
      this.sink.emit({ ...record, attributes })
      return
    }
    if (record.recordType === 'span_start') {
      this.sink.emit({ ...record, attributes })
      return
    }

    const message = this.capture.errorMessage === 'code-only'
      ? undefined
      : record.error?.message
    this.sink.emit({
      ...record,
      status: {
        ...record.status,
        ...(record.status.message
          ? { message: redactSensitiveText(record.status.message).slice(0, 256) }
          : {}),
      },
      ...(record.error
        ? {
            error: {
              ...record.error,
              ...(message
                ? { message: redactSensitiveText(message).slice(0, 1_024) }
                : { message: undefined }),
            },
          }
        : {}),
      attributes,
    })
  }
}
