// Register the example consumer extension module (see `../modular/acme-security.ts`).
//
// ORDERING IS LOAD-BEARING. The layer's own install plugin (`@cat-factory/app`'s
// `modular.client.ts`) is `enforce: 'post'`, and Nuxt runs layer plugins before the
// consuming app's plugins WITHIN one enforce bucket. So a consumer must register from a
// DEFAULT (or `pre`) plugin — as here, with no `enforce` — which runs first; the layer's
// post plugin then resolves the registry with this module already contributed. A consumer
// `enforce: 'post'` plugin would silently register too late and be missed.
//
// `registerAppModule` is auto-imported from the layer (`app/utils/modular.ts`), so a
// consumer needs no deep import into the layer internals — the documented seam.
import { acmeSecurityModule } from '../modular/acme-security'

export default defineNuxtPlugin(() => {
  registerAppModule(acmeSecurityModule)
})
