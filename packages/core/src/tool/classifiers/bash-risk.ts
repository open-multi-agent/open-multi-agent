/**
 * Optional, dependency-free risk heuristic for `bash` commands.
 *
 * Plug it into an `onToolCall` gate to get `safe | review | high` semantics for
 * shell invocations without writing regex tables from scratch:
 *
 * ```ts
 * import { classifyBashCommand } from '@open-multi-agent/core/classifiers'
 *
 * const orchestrator = new OpenMultiAgent({
 *   onToolCall: async (ctx) => {
 *     if (ctx.toolName !== 'bash') return { action: 'allow' }
 *     const risk = classifyBashCommand(ctx.input.command as string)
 *     if (risk.level === 'safe') return { action: 'allow' }
 *     if (risk.level === 'high') return { action: 'deny', reason: risk.reason }
 *     return (await myUi.confirm(ctx, risk)) ? { action: 'allow' } : { action: 'deny', reason: risk.reason }
 *   },
 * })
 * ```
 *
 * **This is a convenience heuristic, NOT a security boundary.** It is a shallow
 * regex/segmentation pass: it strips quoted spans, splits on shell separators
 * (`&&`, `||`, `;`, `|`, newlines) and one level of command substitution, then
 * matches each segment against pattern tables and returns the highest risk
 * found. It can be fooled by obfuscation (variable indirection like `$CMD`,
 * base64-decode-then-exec, unusual quoting, a full nested shell grammar). A
 * `deny` built on it relies on cooperating code — for real isolation use a
 * container / VM / seccomp. The tables are intentionally small and meant to be
 * extended or fully replaced.
 *
 * Unknown / unrecognised commands default to `review` ("don't run blind").
 */

/** Risk level assigned to a bash command. */
export type BashRiskLevel = 'safe' | 'review' | 'high'

/** Result of classifying a bash command. */
export interface BashRiskAssessment {
  /** `safe` (read-only), `review` (ambiguous / context-heavy), `high` (destructive/sensitive). */
  readonly level: BashRiskLevel
  /** Human-readable explanation naming the pattern that set the level. */
  readonly reason: string
}

interface Pattern {
  readonly re: RegExp
  readonly reason: string
}

/**
 * Destructive / sensitive / outbound patterns. Anchored to the start of a
 * segment (after stripping leading `VAR=val` assignments) so a *filename* that
 * merely contains the word does not match.
 */
const HIGH: readonly Pattern[] = [
  { re: /^rm\b/, reason: 'Removes files (rm).' },
  { re: /^sudo\b/, reason: 'Runs a command with elevated privileges (sudo).' },
  { re: /^dd\b/, reason: 'Low-level disk write (dd).' },
  { re: /^mkfs\b/, reason: 'Formats a filesystem (mkfs).' },
  { re: /^shred\b/, reason: 'Irreversibly destroys file contents (shred).' },
  { re: /^chmod\s+(?:-R\b|.*\b777\b)/, reason: 'Broad or recursive permission change (chmod 777 / -R).' },
  { re: /^chown\s+-R\b/, reason: 'Recursive ownership change (chown -R).' },
  { re: /^eval\b/, reason: 'Evaluates a dynamically constructed command (eval).' },
  { re: /:\s*\(\s*\)\s*\{.*:\s*\|\s*:/, reason: 'Fork bomb.' },
  { re: /^git\s+push\b[^\n]*--force(?:-with-lease)?\b/, reason: 'Force-pushes git history (git push --force).' },
  { re: /^git\s+push\b[^\n]*\s-f\b/, reason: 'Force-pushes git history (git push -f).' },
  { re: /^npm\s+publish\b/, reason: 'Publishes a package to a registry (npm publish).' },
  { re: /^(?:yarn|pnpm)\s+publish\b/, reason: 'Publishes a package to a registry.' },
  { re: />\s*\/(?:dev|etc|usr|bin|sbin|boot|System|Library)\b/, reason: 'Redirects output into a system path or device.' },
]

/**
 * Context-heavy or ambiguous patterns worth a human glance but not inherently
 * destructive. Includes the maintainer's named "context bomb" set.
 */
const REVIEW: readonly Pattern[] = [
  { re: /^ls\b[^\n]*\s-\w*R\b/, reason: 'Recursive directory listing (ls -R) can flood context.' },
  { re: /^ls\b[^\n]*--recursive\b/, reason: 'Recursive directory listing (ls --recursive) can flood context.' },
  { re: /^tree\b/, reason: 'Recursive tree listing can flood context.' },
  { re: /^find\s+(?:\/|~|\$HOME)(?:\s|$)/, reason: 'Filesystem-wide find from root/home without a bounded scope.' },
  { re: /^(?:grep|egrep|fgrep|rg)\b[^\n]*\s-\w*[rR]\b/, reason: 'Recursive grep/rg can flood context.' },
  { re: /^(?:grep|egrep|fgrep|rg)\b[^\n]*--recursive\b/, reason: 'Recursive grep/rg can flood context.' },
  { re: /^du\b/, reason: 'Recursive disk-usage scan can be slow/large (du).' },
  { re: /^chmod\b/, reason: 'Changes file permissions (chmod).' },
  { re: /^chown\b/, reason: 'Changes file ownership (chown).' },
  { re: /^(?:bash|sh|zsh|dash|ksh)\s+-c\b/, reason: 'Executes an inline command string via a shell.' },
  { re: /^kill(?:all)?\b/, reason: 'Terminates processes (kill).' },
  { re: /^(?:mv|cp)\s+[^\n]*\s\/(?:etc|usr|bin|sbin|boot|System)\b/, reason: 'Moves/copies into a system path.' },
]

/** Read-only inspection commands. Reached only after HIGH and REVIEW miss. */
const SAFE: readonly Pattern[] = [
  {
    re: /^(?:ls|cat|pwd|echo|printf|head|tail|wc|which|whoami|date|file|stat|env|printenv|hostname|uname|id|df|free|ps|basename|dirname|realpath|readlink|sort|uniq|cut|nl|column|cksum|md5sum|sha1sum|sha256sum)\b/,
    reason: 'Read-only inspection command.',
  },
  {
    re: /^git\s+(?:status|log|diff|show|branch|remote|config|rev-parse|describe|blame|ls-files|shortlog|tag)\b/,
    reason: 'Read-only git query.',
  },
  { re: /^(?:grep|egrep|fgrep|rg)\b/, reason: 'Scoped (non-recursive) text search.' },
  { re: /^find\b/, reason: 'Scoped find (not rooted at / or ~).' },
]

const RANK: Record<BashRiskLevel, number> = { safe: 1, review: 2, high: 3 }

/** Matches a pipe whose right-hand side is a bare shell interpreter (`curl … | bash`). */
const PIPE_TO_SHELL = /\|\s*(?:sudo\s+)?(?:bash|sh|zsh|dash|ksh)\b/

/**
 * Remove quoted spans so tokens *inside* a string literal (e.g. `echo "rm -rf /"`)
 * do not match command patterns. Single quotes first (no interpolation), then
 * double quotes.
 */
function stripQuotes(command: string): string {
  return command.replace(/'[^']*'/g, ' ').replace(/"[^"]*"/g, ' ')
}

/**
 * Break a command into classifiable segments: split the de-quoted top level on
 * shell separators, and pull out one level of command-substitution / backtick
 * bodies as additional segments.
 */
function extractSegments(command: string): string[] {
  const subBodies: string[] = []
  const subRe = /\$\(([^()]*)\)|`([^`]*)`/g
  let m: RegExpExecArray | null
  while ((m = subRe.exec(command)) !== null) {
    subBodies.push(m[1] ?? m[2] ?? '')
  }

  const withoutSubs = command.replace(subRe, ' ')
  const main = stripQuotes(withoutSubs)

  const splitOnSeparators = (s: string): string[] => s.split(/&&|\|\||[;|\n]/)

  const segments = [
    ...splitOnSeparators(main),
    ...subBodies.flatMap((body) => splitOnSeparators(stripQuotes(body))),
  ]

  return segments.map((s) => s.trim()).filter((s) => s.length > 0)
}

/** Classify a single, separator-free segment. Returns null when unrecognised. */
function classifySegment(segment: string): BashRiskAssessment | null {
  // Strip leading `VAR=value` environment assignments so the command token is first.
  const seg = segment.replace(/^(?:\w+=(?:'[^']*'|"[^"]*"|\S*)\s+)+/, '')
  for (const p of HIGH) if (p.re.test(seg)) return { level: 'high', reason: p.reason }
  for (const p of REVIEW) if (p.re.test(seg)) return { level: 'review', reason: p.reason }
  for (const p of SAFE) if (p.re.test(seg)) return { level: 'safe', reason: p.reason }
  return null
}

/**
 * Classify a bash command string as `safe`, `review`, or `high`.
 *
 * Compound commands are segmented and the **highest** risk found is returned,
 * so a safe prefix cannot smuggle a destructive suffix past the gate
 * (`ls && rm -rf /` → `high`). See the module JSDoc for the (deliberate) limits.
 */
export function classifyBashCommand(command: string): BashRiskAssessment {
  if (typeof command !== 'string' || command.trim() === '') {
    return { level: 'review', reason: 'Empty or non-string command; cannot classify.' }
  }

  // `curl … | bash` splits into separate segments, so detect pipe-to-shell on
  // the whole (de-quoted) command before segmenting.
  if (PIPE_TO_SHELL.test(stripQuotes(command))) {
    return { level: 'high', reason: 'Pipes output directly into a shell interpreter (e.g. curl | bash).' }
  }

  const segments = extractSegments(command)
  if (segments.length === 0) {
    return { level: 'review', reason: 'Command could not be parsed into a recognisable form.' }
  }

  let worst: BashRiskAssessment = { level: 'safe', reason: 'All segments are read-only commands.' }
  for (const segment of segments) {
    const assessment = classifySegment(segment) ?? {
      level: 'review' as const,
      reason: `Unrecognised command: "${segment.split(/\s+/)[0] ?? segment}". Review before running.`,
    }
    if (RANK[assessment.level] > RANK[worst.level]) {
      worst = assessment
      if (worst.level === 'high') break
    }
  }
  return worst
}
