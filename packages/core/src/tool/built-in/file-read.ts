/**
 * Built-in file-read tool.
 *
 * Reads a file from disk and returns its contents with 1-based line numbers.
 * Supports reading a slice of lines via `offset` and `limit` for large files.
 */

import { readFile } from 'fs/promises'
import { z } from 'zod'
import { defineTool } from '../framework.js'
import { resolvePathWithinCwd } from './path-safety.js'

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const fileReadTool = defineTool({
  name: 'file_read',
  description:
    'Read the contents of a file from disk. ' +
    'Returns the file contents with line numbers prefixed in the format "N\\t<line>". ' +
    'Use `offset` and `limit` to read large files in chunks without loading the ' +
    'entire file into the context window.',

  inputSchema: z.object({
    path: z.string().describe('Absolute path to the file to read.'),
    offset: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        '1-based line number to start reading from. ' +
          'When omitted the file is read from the beginning.',
      ),
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Maximum number of lines to return. ' +
          'When omitted all lines from `offset` to the end of the file are returned.',
      ),
  }),

  execute: async (input, context) => {
    const safePath = await resolvePathWithinCwd(input.path, context)
    if (!safePath.ok) {
      return { data: safePath.error, isError: true }
    }

    let raw: string
    try {
      const buffer = await readFile(safePath.path)
      raw = buffer.toString('utf8')
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unknown error reading file.'
      return {
        data: `Could not read file "${safePath.path}": ${message}`,
        isError: true,
      }
    }

    // Split preserving trailing newlines correctly
    const lines = raw.split('\n')

    // Remove the last empty string produced by a trailing newline
    if (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop()
    }

    const totalLines = lines.length

    // Apply offset (convert from 1-based to 0-based)
    const startIndex =
      input.offset !== undefined ? Math.max(0, input.offset - 1) : 0

    if (startIndex >= totalLines && totalLines > 0) {
      return {
        data:
          `File "${safePath.path}" has ${totalLines} line${totalLines === 1 ? '' : 's'} ` +
          `but offset ${input.offset} is beyond the end.`,
        isError: true,
      }
    }

    const endIndex =
      input.limit !== undefined
        ? Math.min(startIndex + input.limit, totalLines)
        : totalLines

    const slice = lines.slice(startIndex, endIndex)

    // Build line-numbered output (1-based line numbers matching file positions)
    const numbered = slice
      .map((line, i) => `${startIndex + i + 1}\t${line}`)
      .join('\n')

    const meta =
      endIndex < totalLines
        ? `\n\n(showing lines ${startIndex + 1}–${endIndex} of ${totalLines})`
        : ''

    return {
      data: numbered + meta,
      isError: false,
    }
  },
})
