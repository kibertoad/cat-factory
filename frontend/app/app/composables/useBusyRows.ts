import { reactive } from 'vue'

/**
 * A per-row in-flight guard for lists whose rows each carry their own action buttons: a row's
 * action runs at most once at a time, and the button it belongs to reads `rowBusy(key)` for its
 * spinner. Keys are caller-chosen (`sync:<id>`, `unlink:<id>`), so one row can hold several
 * independent actions.
 */
export function useBusyRows() {
  const busyRows = reactive(new Set<string>())
  const rowBusy = (key: string) => busyRows.has(key)
  async function withRow(key: string, fn: () => Promise<void>) {
    if (busyRows.has(key)) return
    busyRows.add(key)
    try {
      await fn()
    } finally {
      busyRows.delete(key)
    }
  }
  return { rowBusy, withRow }
}
