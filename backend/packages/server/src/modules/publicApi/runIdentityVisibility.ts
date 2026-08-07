/**
 * Who may read the `externalIdentity` a run was pinned with, and how a run says it is withholding
 * one.
 *
 * The rule: **a key carrying an `externalIdentity` of its own sees the identity only on the runs
 * started for THAT identity; a key with none sees every run's.**
 *
 * The feature this guards exists for the integration that mints one key per person, so without a
 * rule every person's key reads back the identity of every other person's runs in the workspace,
 * and that value is routinely an email address. A key that bears an identity IS one person's
 * credential (the provisioner said so at mint time, and it is set once and never edited), so it is
 * exactly the caller that must not enumerate the rest. A key with no identity is the provisioner
 * itself, or one minted in the app by a workspace member who can already read the whole board:
 * that is the caller the run-to-person mapping was built for, and it keeps working unchanged.
 *
 * Two properties are deliberate.
 *
 * It costs NO lookup. Both values are already in hand at every call site (the run's pin, and the
 * calling key's identity, which rides the authenticated context because `authenticate` returns the
 * row it already read). The pin exists so that a page of runs is not a page of key reads, and a
 * visibility rule that re-read the starting key would have given that back on the first request.
 *
 * A withheld identity is STATED, never blanked. `null` already means "this run names nobody" (an
 * app-started run, a schedule, an identity-less key), so returning `null` for a run whose identity
 * the caller may not see would report a mapping the platform is holding as one it never had. The
 * two are different facts and they get different answers.
 *
 * The comparison is exact equality on the stored bytes. The value is opaque in the strongest
 * sense: never parsed, never resolved against a user, never normalised at any other boundary. Case
 * folding or trimming HERE would invent a semantics the mint side does not share, and it would
 * widen the rule (two identities a provisioner considers distinct would read each other's runs)
 * rather than narrow it.
 */

/** What a run projection says about the identity it was started for. */
export type RunIdentityView = {
  /** The pinned identity, or `null` for a run that names nobody AND for one being withheld. */
  externalIdentity: string | null
  /** `true` only when a pinned identity EXISTS and this key may not read it. */
  externalIdentityWithheld: boolean
}

/**
 * Project a run's pinned identity for one reading key.
 *
 * @param pinned the identity stamped on the run at admission (`initiatedByExternalIdentity`)
 * @param readerIdentity the calling key's own identity, `null` for a key minted without one
 */
export function viewRunIdentity(
  pinned: string | null | undefined,
  readerIdentity: string | null,
): RunIdentityView {
  const identity = pinned ?? null
  // Nothing to withhold, and nothing a reader could be denied: answered the same for every key so
  // that "no identity" is one answer rather than a rule with a shape of its own.
  if (identity === null) return { externalIdentity: null, externalIdentityWithheld: false }
  // A key with no identity of its own is the provisioner (or an app-minted key). Full visibility.
  if (readerIdentity === null)
    return { externalIdentity: identity, externalIdentityWithheld: false }
  return identity === readerIdentity
    ? { externalIdentity: identity, externalIdentityWithheld: false }
    : { externalIdentity: null, externalIdentityWithheld: true }
}
