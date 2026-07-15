import { randomBytes, randomUUID } from 'node:crypto'
import type {
  CheckpointSnapshot,
  RunIdentity,
  RunIdentityOptions,
} from '../types.js'

function randomHex(bytes: number): string {
  let value = randomBytes(bytes).toString('hex')
  // W3C identifiers may not be all zero. randomBytes producing all zero is
  // vanishingly unlikely, but enforcing the invariant is cheap and explicit.
  while (/^0+$/.test(value)) value = randomBytes(bytes).toString('hex')
  return value
}

export function validateRunId(runId: string): string {
  if (runId.length < 1 || runId.length > 128) {
    throw new Error('runId must contain between 1 and 128 characters.')
  }
  return runId
}

/** Create the identity for a new logical run. */
export function createRunIdentity(options: RunIdentityOptions = {}): RunIdentity {
  return {
    runId: options.runId === undefined ? randomUUID() : validateRunId(options.runId),
    attempt: 1,
    traceId: randomHex(16),
    rootSpanId: randomHex(8),
  }
}

/** Create the next execution attempt from a v1 or v2 checkpoint. */
export function createRestoreIdentity(
  snapshot: CheckpointSnapshot,
  options: RunIdentityOptions = {},
): RunIdentity {
  const checkpointRunId = snapshot.version === 2
    ? snapshot.identity.runId
    : snapshot.runId

  if (
    options.runId !== undefined
    && checkpointRunId !== undefined
    && options.runId !== checkpointRunId
  ) {
    throw new Error(
      `restore runId conflict: requested "${options.runId}" but checkpoint belongs to "${checkpointRunId}".`,
    )
  }

  const runId = checkpointRunId === undefined
    ? options.runId
    : checkpointRunId
  const baseAttempt = snapshot.version === 2 ? snapshot.identity.attempt : 1
  const identity: RunIdentity = {
    runId: runId === undefined ? randomUUID() : validateRunId(runId),
    attempt: baseAttempt + 1,
    traceId: randomHex(16),
    rootSpanId: randomHex(8),
  }

  if (snapshot.version === 2) {
    return {
      ...identity,
      links: [{
        traceId: snapshot.identity.lastTraceId,
        spanId: snapshot.identity.lastRootSpanId,
        relation: 'continued_from',
      }],
    }
  }

  return identity
}
