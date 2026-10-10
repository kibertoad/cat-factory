// Seeding for the specs whose subject is WHO may do what: a real org with real users, each
// carrying a signed session the SPA can boot as.
//
// There is no anonymous REST path to a user, an account membership or a workspace role (they all
// require a signed-in caller), so these are written through the built container's own services:
// the same shape `makeOnboardingProbe` gives the cross-runtime conformance suite. The shared e2e
// backend runs dev-open for ANONYMOUS requests while still resolving a SIGNED session to its user
// (see `testServer.ts`), so a token minted here drives the board as that principal with the real
// workspace-RBAC gate enforcing.
//
// One generic seeder serves every such spec: `seedTeamScenario` takes the principals a scenario
// needs and the RBAC spec's fixed admin+viewer pair is one call into it. The two facts a scenario
// has to be able to say are:
//
//   - a principal enrolled in the ACCOUNT but NOT scoped to the board (`role: null`), which is what
//     the member-admin flow adds through the roster, and
//   - whether the board starts `restricted` or is restricted later through the UI.
import { makeOnboardingProbe, mintSession } from '@cat-factory/conformance'
import {
  type DrizzleDb,
  DrizzleWorkspaceMemberRepository,
  DrizzleWorkspaceRepository,
  type buildNodeContainer,
} from '@cat-factory/node-server'
import { seedGitHubForWorkspace } from './fakeGitHub.ts'

type Container = ReturnType<typeof buildNodeContainer>

/** A workspace role a seeded principal can hold, or `null` for "account member only". */
export type SeedWorkspaceRole = 'admin' | 'member' | 'viewer' | null

/** One principal a scenario asks for, keyed so the spec can find it in the response. */
export interface TeamPrincipalSpec {
  /** The spec's own handle for this principal (`'reviewer'`, `'outsider'`, …). */
  key: string
  /** The workspace role to scope them with, or `null` to leave them un-scoped. */
  role: SeedWorkspaceRole
  /** Display name; defaults to the key. */
  name?: string
}

/** A seeded principal: their identity plus the Bearer token that drives the SPA as them. */
export interface SeededPrincipal {
  userId: string
  token: string
  name: string
  email: string
  role: SeedWorkspaceRole
}

export interface TeamScenarioRequest {
  /** Makes the seeded users/board unique per test, so retries and parallel runs never collide. */
  tag: string
  /** Whether the board starts limited to its explicit roster (default: unrestricted). */
  restricted?: boolean
  principals?: TeamPrincipalSpec[]
  /**
   * Also create a SECOND, unrestricted and EMPTY board in the same account.
   *
   * For a spec that takes access to the primary board away: the SPA resolves whatever board the
   * caller can still reach, and with none it CREATES one, landing the session on a brand-new
   * board's onboarding gate, a state that says nothing about the revoke. A spare board makes the
   * fall-through a definite place, and it carries no sample architecture precisely so the primary
   * board's fixed block ids (`task_login`) are absent there and can be asserted on.
   */
  spareBoard?: boolean
}

export interface TeamScenario {
  workspaceId: string
  accountId: string
  /** The account OWNER: an admin everywhere via the account-admin escape hatch, with no member row. */
  ownerUserId: string
  ownerToken: string
  principals: Record<string, SeededPrincipal>
  /** The spare board's id, when one was requested (see {@link TeamScenarioRequest.spareBoard}). */
  spareWorkspaceId?: string
}

/** A person who can SIGN IN with a password, and the board they own. */
export interface PasswordUserScenario {
  workspaceId: string
  accountId: string
  userId: string
  email: string
  password: string
  name: string
}

/**
 * Seed a user with a real password credential plus an org and a board they can open.
 *
 * For the sign-in spec, which drives the login FORM: the account and the board are created around
 * the user here because the login screen is the only step under test, and a successful sign-in that
 * lands on an empty deployment proves nothing about the session it minted. The credential is written
 * through the identity service (the same one the signup endpoint calls), so the password the spec
 * types is verified by production code rather than by a fixture.
 */
export async function seedPasswordUser(
  container: Container,
  db: DrizzleDb,
  request: { tag: string; password: string },
): Promise<PasswordUserScenario> {
  const probe = makeOnboardingProbe(container)
  const email = `signin-${request.tag}@example.com`
  const name = `Signin ${request.tag}`
  const user = await probe.users.signupWithPassword({ email, password: request.password, name })
  // The org the board belongs to, owned by someone else, with this user enrolled: a board created
  // for a brand-new personal account would open just the same, but this is the shape a hosted
  // deployment actually has, and it exercises the account-scoped board list the SPA resolves after
  // sign-in.
  const { accountId, ownerUserId } = await probe.makeOrgOwner(`signin-${request.tag}`)
  await probe.addAccountMember(accountId, ownerUserId, user.id, ['developer'])
  const snapshot = await container.workspaceService.create(
    { name: `Sign-in board ${request.tag}`, seed: true },
    null,
    accountId,
  )
  await seedGitHubForWorkspace(db, snapshot.workspace.id, {})
  return {
    workspaceId: snapshot.workspace.id,
    accountId,
    userId: user.id,
    email,
    password: request.password,
    name,
  }
}

/**
 * Seed an org, a board and the requested principals, returning a signed session per principal.
 *
 * The board is created with a NULL owner (no creator auto-enroll), so the owner's full access comes
 * purely from the account-admin escape hatch and a scoped principal's access comes purely from
 * their member row: exactly the separation the RBAC design rests on, and the reason a spec can
 * trust that removing a member row is what locked someone out.
 */
export async function seedTeamScenario(
  container: Container,
  db: DrizzleDb,
  sessionSecret: string,
  request: TeamScenarioRequest,
): Promise<TeamScenario> {
  const { tag, restricted = false, principals: specs = [], spareBoard = false } = request
  const probe = makeOnboardingProbe(container)
  const { accountId, ownerUserId } = await probe.makeOrgOwner(`team-${tag}`)

  // Seed the sample architecture (so the board carries the runnable `task_login` every board-opening
  // helper asserts on) and connect the faked GitHub App, or the SPA sits on the onboarding gate.
  const snapshot = await container.workspaceService.create(
    { name: `Team board ${tag}`, seed: true },
    null,
    accountId,
  )
  const workspaceId = snapshot.workspace.id
  await seedGitHubForWorkspace(db, workspaceId, {})

  const members = new DrizzleWorkspaceMemberRepository(db)
  const principals: Record<string, SeededPrincipal> = {}
  for (const spec of specs) {
    const login = `team-${tag}-${spec.key}`
    const name = spec.name ?? spec.key
    const user = await probe.users.findOrCreateByIdentity('github', login, {
      name,
      email: `${login}@example.com`,
      emailVerified: true,
    })
    await probe.addAccountMember(accountId, ownerUserId, user.id, ['developer'])
    if (spec.role) {
      await members.upsert({
        workspaceId,
        userId: user.id,
        role: spec.role,
        createdAt: Date.now(),
        addedByUserId: ownerUserId,
      })
    }
    principals[spec.key] = {
      userId: user.id,
      token: await mintSession(sessionSecret, { id: user.id, login, name }),
      name,
      email: `${login}@example.com`,
      role: spec.role,
    }
  }
  // Restrict LAST, so the roster written above is what the mode starts enforcing (raw repos: the
  // seed predates any request, so nothing is cached to invalidate).
  if (restricted) await new DrizzleWorkspaceRepository(db).setAccessMode(workspaceId, 'restricted')

  let spareWorkspaceId: string | undefined
  if (spareBoard) {
    const spare = await container.workspaceService.create(
      { name: `Spare board ${tag}`, seed: false },
      null,
      accountId,
    )
    spareWorkspaceId = spare.workspace.id
    // Connect the faked App here too, or this board is the GitHub onboarding gate rather than the
    // definite place a fallen-through session lands.
    await seedGitHubForWorkspace(db, spareWorkspaceId, {})
  }

  return {
    workspaceId,
    accountId,
    ...(spareWorkspaceId ? { spareWorkspaceId } : {}),
    ownerUserId,
    ownerToken: await mintSession(sessionSecret, {
      id: ownerUserId,
      login: `team-${tag}`,
      name: 'Team Owner',
    }),
    principals,
  }
}
