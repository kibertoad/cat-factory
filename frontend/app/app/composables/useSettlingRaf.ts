import { onBeforeUnmount, onMounted } from 'vue'
import { createSettlingLoop, type SettlingLoop } from '~/utils/settlingLoop'

/**
 * Vue lifecycle wrapper around {@link createSettlingLoop}: an animation-frame loop that runs
 * while `compute()` keeps changing something and parks once it settles. The caller wakes it
 * with the returned `poke`, wired to whatever signals can start a change (see
 * `useBoardActivity` for the board's shared set).
 *
 * `compute` MUST report honestly whether it changed anything: returning `true` unconditionally
 * turns this back into the unconditional 60fps loop it replaced.
 */
export function useSettlingRaf(
  compute: () => boolean,
  options: { settleFrames?: number } = {},
): Pick<SettlingLoop, 'poke'> {
  const loop = createSettlingLoop({
    compute,
    settleFrames: options.settleFrames,
    scheduler: {
      schedule: (run) => requestAnimationFrame(run),
      cancel: (handle) => cancelAnimationFrame(handle),
    },
  })

  // The first frame runs on mount: the board arrives with blocks already laid out, and
  // nothing would poke a loop that had never measured anything.
  onMounted(loop.poke)
  onBeforeUnmount(loop.stop)

  return { poke: loop.poke }
}
