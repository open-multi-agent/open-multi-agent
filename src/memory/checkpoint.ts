/**
 * @fileoverview Durable checkpoint persistence over the public MemoryStore API.
 *
 * Checkpoints are stored as JSON under a reserved key namespace. The module
 * intentionally depends only on {@link MemoryStore}, so in-memory, Redis,
 * SQLite, or any custom backend work without extra hooks.
 */

import type { CheckpointOptions, CheckpointSnapshot, MemoryStore } from '../types.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CHECKPOINT_KEY_PREFIX = '__oma_checkpoint__/'
export const DEFAULT_CHECKPOINT_KEY = `${CHECKPOINT_KEY_PREFIX}latest`

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function checkpointKey(runId?: string): string {
  if (!runId) return DEFAULT_CHECKPOINT_KEY
  return `${CHECKPOINT_KEY_PREFIX}${runId}/latest`
}

export function isCheckpointKey(key: string): boolean {
  return key.startsWith(CHECKPOINT_KEY_PREFIX)
}

// ---------------------------------------------------------------------------
// Checkpoint
// ---------------------------------------------------------------------------

export class Checkpoint {
  readonly key: string
  private readonly runId: string | undefined

  constructor(
    private readonly store: MemoryStore,
    options: Pick<CheckpointOptions, 'key' | 'runId'> = {},
  ) {
    this.key = options.key ?? checkpointKey(options.runId)
    this.runId = options.runId
  }

  /** Persist `snapshot` as the latest checkpoint. */
  async save(snapshot: CheckpointSnapshot): Promise<void> {
    const stored: CheckpointSnapshot = {
      ...snapshot,
      ...(snapshot.runId !== undefined || this.runId === undefined
        ? {}
        : { runId: this.runId }),
    }
    await this.store.set(this.key, JSON.stringify(stored), {
      namespace: 'checkpoint',
      version: stored.version,
      ...(stored.runId !== undefined ? { runId: stored.runId } : {}),
      createdAt: stored.createdAt,
    })
  }

  /** Load the latest checkpoint, or `null` when no checkpoint exists. */
  async loadLatest(): Promise<CheckpointSnapshot | null> {
    const entry = await this.store.get(this.key)
    if (entry === null) return null

    let parsed: unknown
    try {
      parsed = JSON.parse(entry.value)
    } catch {
      throw new Error(`Checkpoint: stored value at "${this.key}" is not valid JSON.`)
    }

    if (!Checkpoint.isSnapshot(parsed)) {
      throw new Error(`Checkpoint: stored value at "${this.key}" is not a checkpoint snapshot.`)
    }
    return parsed
  }

  /** Alias for {@link loadLatest}. */
  async load(): Promise<CheckpointSnapshot | null> {
    return this.loadLatest()
  }

  /** Delete the persisted checkpoint key. */
  async delete(): Promise<void> {
    await this.store.delete(this.key)
  }

  private static isSnapshot(value: unknown): value is CheckpointSnapshot {
    if (value === null || typeof value !== 'object') return false
    const snapshot = value as Record<string, unknown>
    if (snapshot['version'] !== 1) return false
    if (snapshot['mode'] !== 'runTeam' && snapshot['mode'] !== 'runTasks') return false
    if (typeof snapshot['createdAt'] !== 'string') return false
    if (!Array.isArray(snapshot['completedTaskResults'])) return false

    const queue = snapshot['queue']
    if (queue === null || typeof queue !== 'object') return false
    const queueRecord = queue as Record<string, unknown>
    return queueRecord['version'] === 1 && Array.isArray(queueRecord['tasks'])
  }
}
