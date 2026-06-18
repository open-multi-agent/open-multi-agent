/**
 * Pure DAG layout for the team-run dashboard (mirrors the browser algorithm).
 */

export interface LayoutTaskInput {
  readonly id: string
  readonly dependsOn?: readonly string[]
}

export interface LayoutTasksResult {
  readonly positions: ReadonlyMap<string, { readonly x: number; readonly y: number }>
  readonly width: number
  readonly height: number
  readonly nodeW: number
  readonly nodeH: number
}

/**
 * Assigns each task to a column by longest path from roots (topological level),
 * then stacks rows within each column. Used by the dashboard canvas sizing.
 */
export function layoutTasks<T extends LayoutTaskInput>(taskList: readonly T[]): LayoutTasksResult {
  const byId = new Map(taskList.map((task) => [task.id, task]))
  const children = new Map<string, string[]>(taskList.map((task) => [task.id, []]))
  const indegree = new Map<string, number>()

  for (const task of taskList) {
    const deps = (task.dependsOn ?? []).filter((dep) => byId.has(dep))
    indegree.set(task.id, deps.length)
    for (const depId of deps) {
      children.get(depId)!.push(task.id)
    }
  }

  const levels = new Map<string, number>()
  const queue: string[] = []
  let processed = 0
  for (const task of taskList) {
    if ((indegree.get(task.id) ?? 0) === 0) {
      levels.set(task.id, 0)
      queue.push(task.id)
    }
  }

  while (queue.length > 0) {
    const currentId = queue.shift()!
    processed += 1
    const baseLevel = levels.get(currentId) ?? 0
    for (const childId of children.get(currentId) ?? []) {
      const nextLevel = Math.max(levels.get(childId) ?? 0, baseLevel + 1)
      levels.set(childId, nextLevel)
      indegree.set(childId, (indegree.get(childId) ?? 1) - 1)
      if ((indegree.get(childId) ?? 0) === 0) {
        queue.push(childId)
      }
    }
  }

  if (processed !== taskList.length) {
    throw new Error('Task dependency graph contains a cycle')
  }

  for (const task of taskList) {
    if (!levels.has(task.id)) levels.set(task.id, 0)
  }

  const cols = new Map<number, T[]>()
  for (const task of taskList) {
    const level = levels.get(task.id) ?? 0
    if (!cols.has(level)) cols.set(level, [])
    cols.get(level)!.push(task)
  }

  const sortedLevels = Array.from(cols.keys()).sort((a, b) => a - b)
  const nodeW = 256
  const nodeH = 142
  const colGap = 96
  const rowGap = 72
  const padX = 120
  const padY = 100
  const positions = new Map<string, { x: number; y: number }>()
  let maxRows = 1
  for (const level of sortedLevels) maxRows = Math.max(maxRows, cols.get(level)!.length)

  for (const level of sortedLevels) {
    const colTasks = cols.get(level)!
    colTasks.forEach((task, idx) => {
      positions.set(task.id, {
        x: padX + level * (nodeW + colGap),
        y: padY + idx * (nodeH + rowGap),
      })
    })
  }

  const width = Math.max(1600, padX * 2 + sortedLevels.length * (nodeW + colGap))
  const height = Math.max(700, padY * 2 + maxRows * (nodeH + rowGap))
  return { positions, width, height, nodeW, nodeH }
}
