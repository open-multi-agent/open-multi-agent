import type { TokenUsage } from '../types.js'

/** @experimental Input shape reserved for future memory-extraction scorers. */
export interface MemoryExtractionSample {
  readonly conversation: unknown
  readonly extracted: readonly {
    readonly content: string
    readonly kind?: string
    readonly scope?: 'private' | 'team'
    readonly provenance?: string
  }[]
  readonly costs?: {
    readonly tokens?: TokenUsage
    readonly durationMs?: number
  }
}

/** @experimental Input shape reserved for future memory-retrieval scorers. */
export interface MemoryRetrievalSample {
  readonly query: unknown
  readonly retrieved: readonly {
    readonly content: string
    readonly scope?: 'private' | 'team'
  }[]
  readonly available?: readonly {
    readonly content: string
    readonly scope?: 'private' | 'team'
  }[]
}
