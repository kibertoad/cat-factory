import type { BlockLevel } from './primitives.js'

/**
 * The module a task belongs to, once it has been moved into a container.
 *
 * A task states its module TWICE and the two are not redundant: `moduleName` is what the author
 * declared, and it exists because the engine only materialises the module BLOCK on merge
 * (`PostMergeBoardController.applyModuleAssignment`), so a task names its destination module long
 * before anything is its parent. The board reads the parent when there is one and falls back to
 * the declared name when there is not.
 *
 * That fallback is why a move has to write BOTH. A task dragged out of a module gains the service
 * frame as its parent but keeps the name it declared, so the fallback files it right back under
 * the module it was just dragged out of, and the gesture reads as broken. The same is true across
 * services: a module name belongs to the service that owns the module, and carrying it into a
 * different frame invents a module there.
 *
 * The rule lives here rather than on either side of the wire because both sides have to agree
 * about it: the server applies it on `reparent` and the SPA has to predict the same answer to
 * place the card optimistically, and a card that lands in one group and then jumps to another is
 * the bug this rule exists to prevent.
 *
 * Returns the empty string for "no module", the same way every other clearable field on
 * `updateBlock` spells a clear.
 */
export function moduleNameInContainer(container: { level: BlockLevel; title: string }): string {
  return container.level === 'module' ? container.title : ''
}
