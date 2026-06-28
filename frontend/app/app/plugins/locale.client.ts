import { useLocaleStore } from '~/stores/locale'

// Restore the user's persisted language choice on boot. The app defaults to English
// (the locale store's default); this only re-applies an EXPLICIT prior pick. Kept
// client-only (the SPA renders client-side) and guarded against an unknown code so a
// stale/removed locale falls back to the i18n default instead of throwing.
export default defineNuxtPlugin(async (nuxtApp) => {
  const i18n = nuxtApp.$i18n as {
    locale: { value: string }
    locales: { value: Array<{ code: string }> }
    setLocale: (code: string) => Promise<void>
  }
  if (!i18n?.setLocale) return

  const stored = useLocaleStore().current
  const supported = i18n.locales.value.some((l) => l.code === stored)
  if (supported && stored !== i18n.locale.value) {
    await i18n.setLocale(stored)
  }
})
