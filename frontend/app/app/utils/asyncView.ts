import { defineAsyncComponent, type AsyncComponentLoader, type Component } from 'vue'
import AsyncViewError from '~/components/common/AsyncViewError.vue'

/**
 * Define a code-split surface (a window, a panel, a modal, the step reader) that STATES it when
 * its chunk fails to load.
 *
 * A bare `defineAsyncComponent` renders nothing on a rejected loader, and the rejection is
 * routine rather than exotic: the SPA is a hashed-chunk build, so a deployment that lands while
 * a tab is open makes every not-yet-fetched chunk a 404, and the first click on a window the
 * session had never opened resolves to a blank screen with no message. On the surfaces these
 * windows serve, that blank is the one a person approves or rejects a run from, so it reads as
 * "there is nothing to review" rather than as a failure. Same rule as the backend's: absent and
 * empty must never render the same.
 *
 * The remedy is a reload rather than a retry, because the chunk the running document is asking
 * for is gone from the origin and re-requesting the same URL cannot bring it back.
 *
 * Use this instead of `defineAsyncComponent` for every surface the app splits out, so a
 * consumer copying the nearest example copies the loud one.
 */
export function defineAsyncView(loader: AsyncComponentLoader): Component {
  return defineAsyncComponent({ loader, errorComponent: AsyncViewError })
}
