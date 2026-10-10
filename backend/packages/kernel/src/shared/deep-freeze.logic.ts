/**
 * Recursively freeze a value and everything reachable from it, returning the same reference.
 *
 * For SHIPPED PLATFORM DATA that is shared by reference rather than rebuilt per caller: a
 * registry's built-in definitions, a catalog the composition root seeds from. Sharing one object
 * across every registry in a process is what lets a caller ask whether a registration IS the
 * platform's own (identity) instead of merely carrying its id, and freezing is what makes the
 * sharing safe: the alternative defence, handing every registry its own copy, buys isolation by
 * destroying exactly the identity that question needs.
 *
 * Deep rather than a bare `Object.freeze`, because a definition's arrays are the part a reader
 * gets a live reference to (a projection hands its `capabilities` array straight out), so a
 * shallow freeze would leave the reachable-and-mutable half untouched.
 *
 * Already-frozen objects are skipped rather than re-walked, which also terminates on a cycle.
 */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<string | symbol, unknown>)[key])
  }
  return value
}
