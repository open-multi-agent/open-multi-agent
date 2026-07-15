import { describe, expect, it } from 'vitest'
import { parseArgs } from '../src/args.js'

describe('parseArgs', () => {
  it('parses project, template, provider, and short flags', () => {
    expect(parseArgs(['my-app', '--template', 'pr-review', '--provider', 'ollama'])).toEqual({
      projectName: 'my-app', templateId: 'pr-review', providerId: 'ollama', help: false,
    })
    expect(parseArgs(['-t', 'security', '-p', 'cloud', 'audit-app']).templateId).toBe('security')
  })

  it('keeps template/provider absent so the CLI can select interactive or legacy defaults', () => {
    expect(parseArgs(['demo-app'])).toEqual({ projectName: 'demo-app', templateId: undefined, providerId: undefined, help: false })
  })

  it('handles help and rejects invalid input before scaffolding', () => {
    expect(parseArgs(['--help']).help).toBe(true)
    expect(() => parseArgs(['x', '--template', 'unknown'])).toThrow('Unknown template')
    expect(() => parseArgs(['x', '--provider'])).toThrow('requires a value')
    expect(() => parseArgs(['x', 'y'])).toThrow('Unexpected second project name')
  })
})
