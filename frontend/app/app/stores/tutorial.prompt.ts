import { ref } from 'vue'

/**
 * The LAUNCH PROMPT's own state machine, extracted from `stores/tutorial.ts`.
 *
 * It is a small machine with four distinguishable exits and no other consumer, which is what makes
 * it a seam worth having rather than four refs among twenty: closing without answering, an explicit
 * decline, a DEFERRAL (something the user must actually answer opened on top), and the
 * once-per-session auto-open are four different things, and only two of them write anything down.
 * The subtlety they share is the ONE-OFFER-PER-SESSION guard, which is why they belong together:
 * `promptAutoOpened` must be spent by an offer the user saw and NOT by one that was withdrawn.
 *
 * `hasDecision` is a bound getter over the persisted record rather than the record itself, so this
 * module never learns what a decision IS — only whether one exists, which is the whole of what the
 * offer needs.
 */
export function createTutorialPrompt(deps: { hasDecision: () => boolean }) {
  const promptOpen = ref(false)
  /** Once-per-session guard for the launch auto-open; later opens are user-driven. */
  const promptAutoOpened = ref(false)

  /**
   * Auto-open the launch prompt, at most once per session and only while the user has never
   * answered it. Callers gate on the rest of the launch context (board ready, no other startup
   * advisory open) — see `pages/index.vue`.
   */
  function maybeOfferOnLaunch() {
    if (deps.hasDecision() || promptAutoOpened.value) return
    promptAutoOpened.value = true
    promptOpen.value = true
  }

  /** User-driven open (command palette), regardless of any saved decision. */
  function openPrompt() {
    promptOpen.value = true
  }

  /**
   * Withdraw an offer this store made, because something the user actually has to answer (a startup
   * advisory, the GitHub onboarding gate) opened on top of it — and re-arm, so the offer returns
   * once that surface is gone. Distinct from {@link closePrompt}: no decision is written EITHER way,
   * but a deferral was not the user's doing, so it must not consume this session's one offer.
   *
   * Only ever withdraws the AUTO-opened prompt; a prompt the user opened themselves from the palette
   * is theirs to close.
   */
  function deferPrompt() {
    if (!promptAutoOpened.value) return
    promptOpen.value = false
    promptAutoOpened.value = false
  }

  /** Close without answering: no decision is written, so the next launch asks again. */
  function closePrompt() {
    promptOpen.value = false
  }

  return { promptOpen, promptAutoOpened, maybeOfferOnLaunch, openPrompt, deferPrompt, closePrompt }
}
