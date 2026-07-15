export type {
  SpanEndRecord,
  SpanEventName,
  SpanEventRecord,
  SpanKind,
  SpanStartRecord,
  TraceRecord,
  TraceRecordBase,
} from './records.js'
export {
  DiagnosticReporter,
  emptyTraceSinkStats,
} from './sink.js'
export type {
  DiagnosticMode,
  DiagnosticOptions,
  ExportResult,
  FlushOptions,
  FlushResult,
  ObservabilityConfig,
  ObservabilityResource,
  TelemetryDiagnostic,
  TelemetryDiagnosticCode,
  TraceCapturePolicy,
  TraceExporter,
  TraceSink,
  TraceSinkStats,
} from './sink.js'
export { BatchingTraceSink, DEFAULT_BATCHING_OPTIONS } from './batching.js'
export type { BatchingTraceSinkOptions } from './batching.js'
export { CompositeSink } from './composite.js'
export { FilteringSink, SensitiveDataProcessor } from './processors.js'
export type {
  SensitiveDataProcessorOptions,
  TraceFilter,
} from './processors.js'
export { LegacyCallbackTraceSink } from './legacy-callback.js'
