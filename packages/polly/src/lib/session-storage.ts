/** Serialize session persistence against logout so late writes cannot resurrect credentials. */
let tail: Promise<void> = Promise.resolve()
export function serialSessionStorage<T>(task: () => Promise<T>): Promise<T> {
  const result = tail.then(task)
  tail = result.then(() => undefined, () => undefined)
  return result
}
