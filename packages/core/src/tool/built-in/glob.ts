/**
 * Built-in glob tool.
 *
 * Lists file paths under a directory matching an optional filename glob.
 * Does not read file contents — use {@link grepTool} to search inside files.
 */

import { stat } from 'fs/promises'
import { basename, relative } from 'path'
import { z } from 'zod'
import type { ToolResult } from '../../types.js'
import { collectFiles, matchesGlob } from './fs-walk.js'
import { defineTool } from '../framework.js'
import { defaultWorkspaceDir, resolvePathWithinCwd } from './path-safety.js'

const DEFAULT_MAX_FILES = 500

export const globTool = defineTool({
  name: 'glob',
  description:
    'List file paths under a directory that match an optional filename glob. ' +
    'Does not read file contents — use `grep` to search inside files. ' +
    'Skips common bulky directories (node_modules, .git, dist, etc.). ' +
    'Paths in the result are relative to the process working directory. ' +
    'Results are capped by `maxFiles`.',

  inputSchema: z.object({
    path: z
      .string()
      .optional()
      .describe(
        'Absolute directory or file path to list. Defaults to the tool working directory.',
      ),
    pattern: z
      .string()
      .optional()
      .describe(
        'Filename glob (e.g. "*.ts", "**/*.json"). When omitted, every file ' +
          'under the directory is listed (subject to maxFiles and skipped dirs).',
      ),
    maxFiles: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        `Maximum number of file paths to return. Defaults to ${DEFAULT_MAX_FILES}.`,
      ),
  }),

  execute: async (input, context): Promise<ToolResult> => {
    const requestedRoot = input.path ?? context.cwd ?? defaultWorkspaceDir()
    const safeRoot = await resolvePathWithinCwd(requestedRoot, context)
    if (!safeRoot.ok) {
      return { data: safeRoot.error, isError: true }
    }

    const root = safeRoot.path
    const maxFiles = input.maxFiles ?? DEFAULT_MAX_FILES
    const signal = context.abortSignal

    let linesOut: string[]
    let truncated = false

    try {
      const info = await stat(root)
      if (info.isFile()) {
        const name = basename(root)
        if (
          input.pattern !== undefined &&
          !matchesGlob(name, input.pattern)
        ) {
          return { data: 'No files matched.', isError: false }
        }
        linesOut = [relative(safeRoot.root, root) || root]
      } else {
        const collected = await collectFiles(root, input.pattern, signal, {
          maxFiles: maxFiles + 1,
        })
        truncated = collected.length > maxFiles
        const capped = collected.slice(0, maxFiles)
        linesOut = capped.map((f) => relative(safeRoot.root, f) || f)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      return {
        data: `Cannot access path "${root}": ${message}`,
        isError: true,
      }
    }

    if (linesOut.length === 0) {
      return { data: 'No files matched.', isError: false }
    }

    const sorted = [...linesOut].sort((a, b) => a.localeCompare(b))
    const truncationNote = truncated
      ? `\n\n(listing capped at ${maxFiles} paths; raise maxFiles for more)`
      : ''

    return {
      data: sorted.join('\n') + truncationNote,
      isError: false,
    }
  },
})
