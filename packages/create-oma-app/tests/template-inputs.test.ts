import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { collectReviewInput, parsePullRequestRef, parseReviewArgs, truncateDiff } from '../templates/pr-review/src/input.js'
import { collectSecurityInput, parseSecurityArgs, redactSecrets } from '../templates/security/src/input.js'

const tempDirs: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.GITHUB_TOKEN
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('PR review input helpers', () => {
  it('parses URL and owner/repo#number references', () => {
    expect(parsePullRequestRef('https://github.com/open-multi-agent/open-multi-agent/pull/42')).toEqual({
      owner: 'open-multi-agent', repo: 'open-multi-agent', number: 42,
    })
    expect(parsePullRequestRef('open-multi-agent/open-multi-agent#7').number).toBe(7)
    expect(() => parsePullRequestRef('github.com/bad')).toThrow('GitHub pull URL')
  })

  it('enforces mutually exclusive modes and base safety', () => {
    expect(parseReviewArgs(['--repo', '../repo', '--base', 'origin/main'])).toMatchObject({ repo: '../repo', base: 'origin/main' })
    expect(() => parseReviewArgs(['--repo', '.', '--pr', 'a/b#1'])).toThrow('exactly one input mode')
    expect(() => parseReviewArgs(['--repo', '.', '--base', '--output'])).toThrow('requires a value')
  })

  it('truncates at a diff file boundary when possible', () => {
    const diff = `diff --git a/a b/a\n${'a'.repeat(30)}\ndiff --git a/b b/b\n${'b'.repeat(30)}\n`
    const result = truncateDiff(diff, 60)
    expect(result.truncated).toBe(true)
    expect(result.text).toContain('DIFF TRUNCATED')
    expect(result.text).not.toContain('b'.repeat(20))
  })

  it('reads a local working-tree diff and reports an empty diff clearly', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'oma-pr-input-'))
    tempDirs.push(repo)
    execFileSync('git', ['init'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
    writeFileSync(join(repo, 'index.ts'), 'export const value = 1\n')
    execFileSync('git', ['add', 'index.ts'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo })
    writeFileSync(join(repo, 'index.ts'), 'export const value = 2\n')
    const input = await collectReviewInput(['--repo', repo])
    expect(input.evidence).toContain('value = 2')
    execFileSync('git', ['checkout', '--', 'index.ts'], { cwd: repo })
    await expect(collectReviewInput(['--repo', repo])).rejects.toThrow('Git diff is empty')
  })

  it('fetches GitHub metadata and diff read-only with optional authentication', async () => {
    process.env.GITHUB_TOKEN = 'test-token-not-logged'
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ title: 'Fix bug', user: { login: 'dev' }, base: { ref: 'main' }, head: { ref: 'fix' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response('diff --git a/a b/a\n+fixed\n', { status: 200 }))
    const input = await collectReviewInput(['--pr', 'owner/repo#12'])
    expect(input.label).toContain('owner/repo#12')
    expect(input.evidence).toContain('+fixed')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect((fetchMock.mock.calls[0]![1]?.headers as Record<string, string>).Authorization).toBe('Bearer test-token-not-logged')
    expect(fetchMock.mock.calls[0]![1]?.method).toBeUndefined()
  })

  it('surfaces GitHub authorization and rate-limit failures', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('rate limited', { status: 403 }))
    await expect(collectReviewInput(['--pr', 'owner/repo#12'])).rejects.toThrow('HTTP 403')
  })
})

describe('security input helpers', () => {
  it('parses explicit online audit and rejects demo combinations', () => {
    expect(parseSecurityArgs(['--repo', '../repo', '--online-audit'])).toEqual({ demo: false, repo: '../repo', onlineAudit: true })
    expect(parseSecurityArgs([]).onlineAudit).toBe(false)
    expect(() => parseSecurityArgs(['--demo', '--online-audit'])).toThrow('cannot be used')
  })

  it('redacts secret-looking values while preserving ordinary source', () => {
    const text = 'const ok = true\napi_key = "supersecretvalue"\nconst token = "ghp_abcdefghijklmnopqrstuvwxyz"'
    const redacted = redactSecrets(text)
    expect(redacted).toContain('const ok = true')
    expect(redacted).not.toContain('supersecretvalue')
    expect(redacted).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz')
    expect(redacted).toContain('[REDACTED')
  })

  it('collects bounded evidence, excludes dependencies, and never includes secret values', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'oma-security-input-'))
    tempDirs.push(repo)
    mkdirSync(join(repo, 'src'))
    mkdirSync(join(repo, 'node_modules'))
    writeFileSync(join(repo, 'src', 'server.ts'), 'const api_key = "supersecretvalue"\nexport const ok = true\n')
    writeFileSync(join(repo, 'node_modules', 'ignored.ts'), 'password = "ignored-secret"\n')
    writeFileSync(join(repo, 'package.json'), '{"dependencies":{"express":"4.17.0"}}')
    const input = await collectSecurityInput(['--repo', repo])
    expect(input.evidence).toContain('src/server.ts')
    expect(input.evidence).toContain('[REDACTED generic-secret]')
    expect(input.evidence).not.toContain('supersecretvalue')
    expect(input.evidence).not.toContain('ignored-secret')
    expect(input.metadata.onlineAudit).toBe(false)
  })
})
