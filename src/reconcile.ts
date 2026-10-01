/** Retain references for unchanged JSON records so Solid does not remount their renderables. */
export function reuseRecord<T>(previous: T | undefined | null, next: T): T {
  return previous != null && JSON.stringify(previous) === JSON.stringify(next) ? previous : next
}
export function reuseRecords<T>(previous: T[], next: T[], key: (value: T) => string | number | undefined): T[] {
  const indexed = new Map<string | number, T | undefined>()
  for (const item of previous) {
    const id = key(item)
    if (id !== undefined) indexed.set(id, indexed.has(id) ? undefined : item)
  }
  const items = next.map((item, index) => {
    const id = key(item), old = id === undefined ? previous[index] : indexed.get(id)
    // Duplicate fingerprints must not reuse the same renderable twice.
    if (id !== undefined) indexed.delete(id)
    return reuseRecord(old, item)
  })
  return items.length === previous.length && items.every((item, index) => item === previous[index]) ? previous : items
}
