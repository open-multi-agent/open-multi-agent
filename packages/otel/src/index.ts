export {
  OMA_OTEL_MAPPING_VERSION,
  OMA_SCHEMA_VERSION,
  OTEL_GENAI_SEMCONV_VERSION,
  addGenAiAttributes,
  isSafeOmaAttribute,
  mapLink,
  mapOmaAttributes,
  mapSpanKind,
  mapStatus,
} from './mapping.js'
export {
  createOtelTraceExporter,
  createOtelTraceSink,
  OTelTraceExporter,
} from './exporter.js'
export type {
  OTelDiagnostic,
  OTelDiagnosticCode,
  OTelContentCaptureExtension,
  OTelMetadata,
  OTelTraceExporterOptions,
  OTelTraceSinkOptions,
  OTelTracerProvider,
} from './exporter.js'
