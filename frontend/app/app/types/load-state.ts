/**
 * How far a read has got: the SPA's one vocabulary for load progress.
 *
 * Four states rather than a nullable value, because an absent value is not a single fact. "Nobody
 * asked", "the read is in flight" and "the read failed" need three different answers on screen and
 * only the middle one is temporary; collapsed into one `null` they all render as whatever the
 * surface shows for "no data", which is usually the empty state and is wrong for two of them.
 *
 * A REFRESH is deliberately not a fifth member. A read that already has an answer keeps it, so a
 * surface asking "what do I show" reads the value it holds and a surface asking "is something in
 * flight" reads `loading`; a re-read that downgraded the surface to `loading` would replace a
 * usable panel with a spinner for a fact it can already state.
 *
 * A status carrying a member this does not have keeps its own type (`NotificationSettingsStatus`
 * distinguishes "the deployment does not offer this" from a failure, which is a fifth fact rather
 * than a renaming of one of these four).
 */
export type LoadState = 'idle' | 'loading' | 'ready' | 'error'
