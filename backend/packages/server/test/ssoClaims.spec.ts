import { describe, expect, it } from 'vitest'
import {
  judgeSsoAdmission,
  needsUserinfo,
  readGroupClaim,
  readSsoIdentity,
  userinfoMatchesSubject,
} from '../src/auth/oidc/claims.js'
import type { SsoConfig } from '../src/config/types.js'

// The two judgements an enterprise SSO sign-in turns on — what counts as the identity, and who is
// admitted — tested here because they are pure and because getting either wrong is silent: a
// misread groups claim refuses the whole org, and a too-loose admission admits people the
// deployment's own rules exclude.

function config(overrides: Partial<SsoConfig> = {}): SsoConfig {
  return {
    issuerUrl: 'https://acme.okta.com/oauth2/default',
    clientId: 'cid',
    clientSecret: 'secret',
    label: 'Acme SSO',
    scopes: 'openid profile email',
    redirectUrl: '',
    allowedEmailDomains: [],
    groupsClaim: 'groups',
    requiredGroups: [],
    ...overrides,
  }
}

describe('readGroupClaim', () => {
  // Providers disagree about the SHAPE far more than the name, and every unhandled shape reads as
  // "this user has no groups" — which a requiredGroups gate turns into a refusal that looks
  // exactly like an operator typo.
  it('reads an array of strings (Okta, Keycloak)', () => {
    expect(readGroupClaim({ groups: ['Engineering', 'Ops'] }, 'groups')).toEqual([
      'engineering',
      'ops',
    ])
  })

  it('reads a single string value', () => {
    expect(readGroupClaim({ groups: 'Engineering' }, 'groups')).toEqual(['engineering'])
  })

  it('splits a BARE space-separated string (a SAML-to-OIDC bridge)', () => {
    // Only the scalar shape is ambiguous, so only the scalar shape is split.
    expect(readGroupClaim({ groups: 'engineering ops' }, 'groups')).toEqual(['engineering', 'ops'])
  })

  it('keeps a space inside an ARRAY entry, because the array already delimited it', () => {
    // The lockout this file's header warns about, from the opposite direction: AD-backed
    // directories (Entra ID, Okta) permit spaces in a group's display name, and
    // AUTH_SSO_REQUIRED_GROUPS splits on COMMAS, so "Domain Admins" is perfectly addressable.
    // Splitting the claim into `domain` + `admins` matches nothing an operator can write, and the
    // refusal that follows reads exactly like they got the group names wrong.
    expect(readGroupClaim({ groups: ['Domain Admins', 'Engineering'] }, 'groups')).toEqual([
      'domain admins',
      'engineering',
    ])
  })

  it('keeps a space inside an object entry too', () => {
    expect(readGroupClaim({ groups: [{ value: 'Domain Admins' }] }, 'groups')).toEqual([
      'domain admins',
    ])
  })

  it('reads objects carrying `value` or `name`', () => {
    expect(
      readGroupClaim({ groups: [{ value: 'Engineering' }, { name: 'Ops' }] }, 'groups'),
    ).toEqual(['engineering', 'ops'])
  })

  it('keeps the recognisable entries when one is an unknown shape', () => {
    // A single odd entry must not discard the rest of a user's memberships.
    expect(readGroupClaim({ groups: ['ops', 42, null, { other: 'x' }] }, 'groups')).toEqual(['ops'])
  })

  it('reads a non-default claim name (Entra ID / a Shibboleth OP)', () => {
    expect(readGroupClaim({ isMemberOf: ['staff'] }, 'isMemberOf')).toEqual(['staff'])
  })

  it('is empty for an absent claim, and for an empty claim name', () => {
    expect(readGroupClaim({}, 'groups')).toEqual([])
    expect(readGroupClaim({ groups: ['ops'] }, '')).toEqual([])
  })
})

describe('readSsoIdentity', () => {
  it('keys on `sub` and lowercases the email', () => {
    const identity = readSsoIdentity(
      { sub: 'okta-1', email: 'Ada@Acme.com', name: 'Ada Lovelace', picture: 'https://a/i.png' },
      config(),
    )
    expect(identity).toMatchObject({
      sub: 'okta-1',
      email: 'ada@acme.com',
      name: 'Ada Lovelace',
      avatarUrl: 'https://a/i.png',
      login: 'ada@acme.com',
    })
  })

  it('returns null with no `sub`, rather than falling back to the email', () => {
    // The email is display data orgs reassign; keying an account on it hands a departed
    // employee's workspace to whoever inherits their address.
    expect(readSsoIdentity({ email: 'ada@acme.com' }, config())).toBeNull()
  })

  it('prefers `preferred_username` as the display handle', () => {
    expect(
      readSsoIdentity({ sub: 's', preferred_username: 'ada', email: 'a@b.c' }, config()),
    ).toMatchObject({ login: 'ada' })
  })

  it('falls back to the `sub` when neither a username nor an email is released', () => {
    expect(readSsoIdentity({ sub: 'okta-1' }, config())).toMatchObject({ login: 'okta-1' })
  })

  it('composes a name from `given_name`/`family_name` when `name` is absent', () => {
    expect(
      readSsoIdentity({ sub: 's', given_name: 'Ada', family_name: 'Lovelace' }, config()),
    ).toMatchObject({ name: 'Ada Lovelace' })
  })

  it('treats an ABSENT email_verified as verified, and an explicit false as unverified', () => {
    // The decision documented on `SsoIdentity.emailVerified`: enterprise ID tokens routinely omit
    // the claim for an address that came straight out of the corporate directory, and requiring it
    // would fork a second account (with no email at all) for anyone who also signed in with
    // GitHub. An explicit `false` is still honoured.
    expect(readSsoIdentity({ sub: 's', email: 'a@b.c' }, config())).toMatchObject({
      emailVerified: true,
    })
    expect(
      readSsoIdentity({ sub: 's', email: 'a@b.c', email_verified: false }, config()),
    ).toMatchObject({ emailVerified: false })
  })

  it('is not "verified" when there is no email at all', () => {
    expect(readSsoIdentity({ sub: 's' }, config())).toMatchObject({
      email: null,
      emailVerified: false,
    })
  })

  it('honours a STRING "false" from a provider that ships booleans as strings', () => {
    // Absence means verified, so the only thing left to catch is a provider saying "no" — and
    // reading `"false"` as verified would invert its own answer rather than fill a gap.
    expect(
      readSsoIdentity({ sub: 's', email: 'a@b.c', email_verified: 'false' }, config()),
    ).toMatchObject({ emailVerified: false })
    // A string "true" is still verified, as absence would have been anyway.
    expect(
      readSsoIdentity({ sub: 's', email: 'a@b.c', email_verified: 'true' }, config()),
    ).toMatchObject({ emailVerified: true })
  })
})

describe('userinfoMatchesSubject', () => {
  // OIDC Core 5.3.2. Overlaying the ID token's claims last already stops `sub` being taken from
  // userinfo, but `email` and `groups` ride the same response and BOTH decide admission — so a
  // response for another subject is the one way a group gate is satisfied by someone else's
  // membership.
  it('matches when the response describes the same subject', () => {
    expect(userinfoMatchesSubject({ sub: 'okta-1' }, { sub: 'okta-1' })).toBe(true)
  })

  it('refuses a response for a DIFFERENT subject', () => {
    expect(userinfoMatchesSubject({ sub: 'okta-2' }, { sub: 'okta-1' })).toBe(false)
  })

  it('refuses a response with no `sub`, where the claim is REQUIRED', () => {
    // A merge that cannot be checked is not one to trust.
    expect(userinfoMatchesSubject({ email: 'a@b.c' }, { sub: 'okta-1' })).toBe(false)
    expect(userinfoMatchesSubject({ sub: '  ' }, { sub: 'okta-1' })).toBe(false)
  })
})

describe('judgeSsoAdmission', () => {
  const identity = (overrides: Record<string, unknown> = {}) =>
    readSsoIdentity(
      { sub: 's', email: 'ada@acme.com', groups: ['engineering'], ...overrides },
      config(),
    )!

  it("admits by default — the provider's own app assignment IS the allowlist", () => {
    // Deliberately NOT fail-closed, unlike the GitHub login/org lists: expressing membership in
    // the directory instead of in a local list is the capability SSO is adopted for.
    expect(judgeSsoAdmission(identity(), config())).toEqual({ allowed: true })
  })

  it('refuses a user in none of the required groups', () => {
    expect(
      judgeSsoAdmission(
        identity({ groups: ['marketing'] }),
        config({ requiredGroups: ['engineering'] }),
      ),
    ).toEqual({ allowed: false, reason: 'group_required' })
  })

  it('admits on ANY one of the required groups', () => {
    expect(
      judgeSsoAdmission(identity(), config({ requiredGroups: ['ops', 'engineering'] })),
    ).toEqual({ allowed: true })
  })

  it('refuses an email domain outside the allowlist', () => {
    expect(judgeSsoAdmission(identity(), config({ allowedEmailDomains: ['other.com'] }))).toEqual({
      allowed: false,
      reason: 'domain_not_allowed',
    })
  })

  it('admits an allowlisted domain', () => {
    expect(judgeSsoAdmission(identity(), config({ allowedEmailDomains: ['acme.com'] }))).toEqual({
      allowed: true,
    })
  })

  it('refuses rather than admits when a domain gate has no email to evaluate', () => {
    // Admitting here would silently VOID a rule the operator wrote; the remedy (release the email
    // claim) is theirs, so the refusal has to name it.
    expect(
      judgeSsoAdmission(
        readSsoIdentity({ sub: 's' }, config())!,
        config({ allowedEmailDomains: ['acme.com'] }),
      ),
    ).toEqual({ allowed: false, reason: 'email_required' })
  })

  it('refuses an UNVERIFIED email against a domain gate', () => {
    expect(
      judgeSsoAdmission(
        identity({ email_verified: false }),
        config({ allowedEmailDomains: ['acme.com'] }),
      ),
    ).toEqual({ allowed: false, reason: 'email_required' })
  })

  it('reports the GROUP refusal first when both gates would refuse', () => {
    // Ordering is deliberate: the group remedy is the actionable one for the user.
    expect(
      judgeSsoAdmission(
        identity({ groups: ['marketing'] }),
        config({ requiredGroups: ['engineering'], allowedEmailDomains: ['other.com'] }),
      ),
    ).toEqual({ allowed: false, reason: 'group_required' })
  })
})

describe('needsUserinfo', () => {
  it('is false when the ID token already carries everything admission reads', () => {
    expect(needsUserinfo({ sub: 's', email: 'a@b.c' }, config())).toBe(false)
  })

  it('is true when the ID token released no email', () => {
    expect(needsUserinfo({ sub: 's' }, config())).toBe(true)
  })

  it('is true when a group gate is configured and the token carries no groups', () => {
    // The Entra ID shape: `email` in the ID token, `groups` only from userinfo.
    expect(
      needsUserinfo({ sub: 's', email: 'a@b.c' }, config({ requiredGroups: ['engineering'] })),
    ).toBe(true)
  })

  it('is false when a group gate is configured and the token already carries groups', () => {
    // The extra round-trip happens only when it can change the outcome.
    expect(
      needsUserinfo(
        { sub: 's', email: 'a@b.c', groups: ['engineering'] },
        config({ requiredGroups: ['engineering'] }),
      ),
    ).toBe(false)
  })
})
