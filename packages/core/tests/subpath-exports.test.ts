import { describe, it, expect } from 'vitest'

/**
 * Smoke test for the package's subpath export barrels. Tests run against `src`
 * (not the published `@open-multi-agent/core/*` names), so we import each entry
 * barrel by its relative source path and assert the public symbols resolve. This
 * guards against a barrel that references a moved/renamed implementation module.
 */
describe('subpath export barrels', () => {
  it('/classifiers exposes classifyBashCommand', async () => {
    const mod = await import('../src/classifiers.js')
    expect(typeof mod.classifyBashCommand).toBe('function')
    expect(mod.classifyBashCommand('ls').level).toBe('safe')
  })

  it('/mcp exposes connectMCPTools', async () => {
    const mod = await import('../src/mcp.js')
    expect(typeof mod.connectMCPTools).toBe('function')
  })

  it('/ai-sdk exposes AISdkAdapter', async () => {
    const mod = await import('../src/ai-sdk.js')
    expect(typeof mod.AISdkAdapter).toBe('function')
  })
})
