import type {
  ExecutionRoutingDecisionRecord,
  ExecutionRoutingDecisionSource,
  RoutingDecision,
  RunIdentity,
  RoutingDecisionTrace,
} from '../types.js'
import type { TraceRuntime } from './runtime.js'

export interface RoutingDecisionRecordInput {
  readonly source: ExecutionRoutingDecisionSource
  readonly mode: RoutingDecision['mode']
  readonly confidence?: number
  readonly reasons: readonly string[]
  readonly routerVersion?: string
}

/**
 * Records one execution-routing decision through the existing trace runtime.
 * The returned result field and its future ExecutionReceipt share stable IDs.
 */
export function recordRoutingDecision(
  identity: RunIdentity,
  traceRuntime: TraceRuntime | undefined,
  input: RoutingDecisionRecordInput,
): ExecutionRoutingDecisionRecord {
  const decisionId = `${identity.traceId}:routing-decision`
  const receiptId = `${identity.traceId}:execution-receipt`
  const span = traceRuntime?.startSpan({
    kind: 'routing',
    name: 'decide_execution_route',
    parent: traceRuntime.root,
    attributes: {
      'oma.routing.decision_id': decisionId,
      'oma.routing.receipt_id': receiptId,
      'oma.routing.source': input.source,
      'oma.routing.mode': input.mode,
      'oma.routing.reasons': input.reasons,
      ...(input.routerVersion !== undefined
        ? { 'oma.routing.router_version': input.routerVersion }
        : {}),
      ...(input.confidence !== undefined
        ? { 'oma.routing.confidence': input.confidence }
        : {}),
    },
  })
  const record: ExecutionRoutingDecisionRecord = {
    decisionId,
    receiptId,
    ...(span ? { traceSpanId: span.spanId } : {}),
    source: input.source,
    mode: input.mode,
    reasons: input.reasons,
    ...(input.routerVersion !== undefined ? { routerVersion: input.routerVersion } : {}),
    ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
  }
  if (span) {
    const endMs = Date.now()
    const legacyEvent: RoutingDecisionTrace = {
      type: 'routing_decision',
      runId: identity.runId,
      spanId: span.spanId,
      parentId: identity.rootSpanId,
      agent: 'orchestrator',
      decisionId,
      receiptId,
      source: input.source,
      mode: input.mode,
      reasons: input.reasons,
      ...(input.routerVersion !== undefined ? { routerVersion: input.routerVersion } : {}),
      ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
      startMs: span.startUnixMs,
      endMs,
      durationMs: Math.max(0, endMs - span.startUnixMs),
    }
    span.end({ status: { code: 'ok' }, legacyEvent })
  }
  return record
}
