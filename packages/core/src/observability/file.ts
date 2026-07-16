/** Node-only FileTraceStore entrypoint: `@open-multi-agent/core/observability/file`. */

export {
  FILE_TRACE_STORE_FORMAT,
  FILE_TRACE_STORE_FORMAT_VERSION,
  FileTraceStore,
  FileTraceStoreError,
} from './file-store.js'
export type {
  FileTraceStoreCompactionResult,
  FileTraceStoreDiagnostic,
  FileTraceStoreDiagnosticCode,
  FileTraceStoreErrorCode,
  FileTraceStoreOptions,
} from './file-store.js'
