/**
 * @fileoverview Centralized configuration with env-var support.
 *
 * Config priority: constructor args (overrides) > env vars > defaults.
 *
 * Supported environment variables:
 * - `VCG_VLLM_URL`          — vLLM base URL
 * - `VCG_VLLM_MODEL`        — vLLM model name
 * - `VCG_VLLM_API_KEY`      — vLLM auth token
 * - `VCG_DEFAULT_PROVIDER`   — 'vllm' | 'anthropic' | 'openai'
 * - `VCG_MAX_CONCURRENCY`    — default concurrency limit
 * - `VCG_LOG_LEVEL`          — 'debug' | 'info' | 'warn' | 'error' | 'silent'
 *
 * @module @vcg/agent-sdk
 */

import type { VCGConfig } from '../types.js'

/** Valid log levels for the SDK. */
const VALID_LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const

/** Valid provider names. */
const VALID_PROVIDERS = ['anthropic', 'openai', 'vllm'] as const

/**
 * Default configuration values used when no override or env var is present.
 */
export const DEFAULT_CONFIG: Readonly<VCGConfig> = {
  defaultProvider: 'anthropic',
  maxConcurrency: 5,
  logLevel: 'info',
}

/**
 * Build a fully-resolved configuration by merging (in priority order):
 *   1. Explicit `overrides` (constructor args)
 *   2. Environment variables
 *   3. {@link DEFAULT_CONFIG}
 *
 * Only defined override fields take precedence; `undefined` fields fall through
 * to env vars, then to defaults.
 */
export function loadConfig(overrides?: Partial<VCGConfig>): VCGConfig {
  const env = readEnv()

  return {
    defaultProvider: overrides?.defaultProvider ?? env.defaultProvider ?? DEFAULT_CONFIG.defaultProvider,
    maxConcurrency: overrides?.maxConcurrency ?? env.maxConcurrency ?? DEFAULT_CONFIG.maxConcurrency,
    logLevel: overrides?.logLevel ?? env.logLevel ?? DEFAULT_CONFIG.logLevel,
    vllm: overrides?.vllm ?? env.vllm,
  }
}

// ---------------------------------------------------------------------------
// Internal: read env vars into a partial config
// ---------------------------------------------------------------------------

type MutablePartialConfig = { -readonly [K in keyof VCGConfig]?: VCGConfig[K] }

function readEnv(): MutablePartialConfig {
  const result: MutablePartialConfig = {}

  // Provider
  const provider = process.env['VCG_DEFAULT_PROVIDER']
  if (provider && (VALID_PROVIDERS as readonly string[]).includes(provider)) {
    result.defaultProvider = provider as VCGConfig['defaultProvider']
  }

  // Concurrency
  const concurrency = process.env['VCG_MAX_CONCURRENCY']
  if (concurrency) {
    const parsed = parseInt(concurrency, 10)
    if (!isNaN(parsed) && parsed > 0) {
      result.maxConcurrency = parsed
    }
  }

  // Log level
  const logLevel = process.env['VCG_LOG_LEVEL']
  if (logLevel && (VALID_LOG_LEVELS as readonly string[]).includes(logLevel)) {
    result.logLevel = logLevel as VCGConfig['logLevel']
  }

  // vLLM
  const vllmURL = process.env['VCG_VLLM_URL']
  const vllmModel = process.env['VCG_VLLM_MODEL']
  if (vllmURL && vllmModel) {
    result.vllm = {
      baseURL: vllmURL,
      model: vllmModel,
      apiKey: process.env['VCG_VLLM_API_KEY'],
    }
  }

  return result
}
