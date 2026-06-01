/**
 * @fileoverview Hunyuan (Tencent) adapter.
 *
 * Thin wrapper around OpenAIAdapter that defaults to Tencent Hunyuan's current
 * MaaS / TokenHub OpenAI-compatible endpoint, with a HUNYUAN_API_KEY
 * environment variable fallback.
 */

import { OpenAIAdapter } from './openai.js'

/**
 * LLM adapter for Tencent Hunyuan models.
 *
 * Thread-safe. Can be shared across agents.
 *
 * Usage:
 *   provider: 'hunyuan'
 *   model: 'hy3-preview' (or any model available to your Hunyuan API key)
 *
 * Tool calling is verified on the hy3-preview, hunyuan-turbos, and
 * hunyuan-functioncall model families.
 *
 * Tencent exposes Hunyuan through two independent OpenAI-compatible surfaces
 * with separate API-key namespaces:
 *   - Tencent MaaS / TokenHub (default): https://tokenhub.tencentmaas.com/v1,
 *     models like `hy3-preview`, `sk-...` keys. This is Tencent's current
 *     platform.
 *   - Legacy Tencent Cloud: https://api.hunyuan.cloud.tencent.com/v1,
 *     models like `hunyuan-turbos-latest`, console keys. Tencent has
 *     announced this platform is being retired (sales stop 2026-06-30, full
 *     shutdown 2026-09-30); target it via `HUNYUAN_BASE_URL` until then.
 * Set `HUNYUAN_BASE_URL` (or pass `baseURL`) to target the legacy endpoint or
 * any future cluster without code changes.
 */
export class HunyuanAdapter extends OpenAIAdapter {
  readonly name = 'hunyuan'

  constructor(apiKey?: string, baseURL?: string) {
    // Default to the current Tencent MaaS / TokenHub endpoint; allow override
    // of baseURL (legacy Tencent Cloud endpoint, proxies, or future clusters).
    super(
      apiKey ?? process.env['HUNYUAN_API_KEY'],
      baseURL ?? process.env['HUNYUAN_BASE_URL'] ?? 'https://tokenhub.tencentmaas.com/v1'
    )
  }
}
