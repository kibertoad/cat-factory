/**
 * The "foundation" slice of the domain composition root, extracted verbatim from `createCore`
 * (no behaviour change): the always-present spine services built BEFORE the board's friction
 * guards and the execution engine — notifications, workspace settings, the board / workspace /
 * account / user services — plus the account-onboarding optional modules (workspace members,
 * email connections, invitations, password reset).
 *
 * None of these depends on a value constructed later in `createCore`; the ONE late-binding — the
 * account service invalidating the (later-built) spend service's cached account-budget limit — is
 * threaded in through the `getSpendService` accessor, so `spendServiceRef` stays owned by
 * `createCore` and the read still happens at call time, exactly as before.
 *
 * The {@link ModuleRegistry} instance is owned by `createCore` and passed in, so the optional
 * modules this factory declares (`notifications`/`settings`/`workspaceMemberService`/`email`/
 * `invitations`/`passwordReset`) register in the SAME order they did inline — registration order
 * IS dependency order — and `modules.assemble()` at the return still emits them.
 */

import { BoardService } from '../modules/board/BoardService.js'
import {
  AccountService,
  InvitationService,
  PasswordResetService,
  UserService,
  WorkspaceMemberService,
  WorkspaceService,
} from '@cat-factory/workspaces'
import { EmailConnectionService } from '@cat-factory/integrations'
import type { SpendService } from '@cat-factory/spend'
import type { EnvironmentHandlerSeeder, SharedStackSeeder } from '@cat-factory/kernel'
import { createNotificationsModule, createWorkspaceSettingsModule } from './modules.js'
import type { ModuleRegistry } from './module-registry.js'
import type { resolveCoreRuntime } from './runtime.js'
import type {
  CoreDependencies,
  NotificationsModule,
  WorkspaceSettingsModule,
} from '../container.js'

type CoreRuntime = ReturnType<typeof resolveCoreRuntime>

export interface CoreFoundationParams {
  dependencies: CoreDependencies
  /** Owned by `createCore` so the optional modules assemble in one place; passed in here. */
  modules: ModuleRegistry
  caches: CoreRuntime['caches']
  executionEventPublisher: CoreRuntime['executionEventPublisher']
  taskTypeRegistry: CoreRuntime['taskTypeRegistry']
  pipelineRegistry: CoreRuntime['pipelineRegistry']
  /** The RESOLVED prompt-fragment pool source (own registry, or the mothership's). */
  promptFragments: CoreRuntime['promptFragments']
  /** Late-bound spend-service accessor (built after the foundation) for the account-budget cache. */
  getSpendService: () => SpendService | undefined
  /**
   * Late-bound environment-handler-seeder accessor (built after the foundation, over the
   * environments module) so `WorkspaceService.create` seeds a new board's declared infra handlers.
   */
  getEnvironmentHandlerSeeder: () => EnvironmentHandlerSeeder | undefined
  /**
   * Late-bound shared-stack-seeder accessor (built after the foundation, over the shared-stacks
   * module) so `WorkspaceService.create` seeds a new board's declared shared stacks too.
   */
  getSharedStackSeeder: () => SharedStackSeeder | undefined
}

export interface CoreFoundation {
  notifications: NotificationsModule | undefined
  settings: WorkspaceSettingsModule | undefined
  boardService: BoardService
  workspaceService: WorkspaceService
  accountService: AccountService
  userService: UserService
}

/**
 * Build the foundation services + account-onboarding modules. Extracted from `container.ts` as a
 * cohesive collaborator (the file-size ratchet: split, never grow); returns the handles the rest
 * of `createCore` threads into the board friction guards, the execution engine, and the spine.
 */
export function createCoreFoundation(params: CoreFoundationParams): CoreFoundation {
  const {
    dependencies,
    modules,
    caches,
    executionEventPublisher,
    taskTypeRegistry,
    pipelineRegistry,
    promptFragments,
    getSpendService,
    getEnvironmentHandlerSeeder,
    getSharedStackSeeder,
  } = params

  // Built up-front (before the board + execution engine) so the board's review-debt friction
  // guard on task creation, the per-service task limit, and the escalation sweep can all read
  // them. Neither module depends on any service constructed below — only `dependencies` + the
  // settings cache slice — so building them here is safe and keeps the locals threadable.
  const notifications = modules.build('notifications', () =>
    createNotificationsModule(dependencies),
  )
  const settings = modules.build('settings', () =>
    createWorkspaceSettingsModule(dependencies, caches.workspaceSettings),
  )
  // Pass the resolved publisher so board mutations push a coarse `boardChanged` to every
  // user on the workspace (and every board mounting a shared service) — both facades route
  // here, so the wiring is symmetric by construction. The repo-projection cache lets
  // `addServiceFromRepo`'s monorepo-flag write invalidate the same group the resolver reads.
  const boardService = new BoardService({
    ...dependencies,
    executionEventPublisher,
    repoProjectionCache: caches.repoProjection,
    // The resolved (defaulted) task-type registry, so a custom-typed task resolves its
    // deployment-registered default pipeline (the raw `dependencies.taskTypeRegistry` may be
    // undefined; this is the same instance re-exposed on `Core` for the snapshot projection).
    taskTypeRegistry,
    // Where a new task's per-type default fragment ids come from: the RESOLVED source, so a
    // mothership-mode node seeds from the mothership's registered sets rather than its own build's.
    promptFragmentSource: promptFragments,
    // The acting workspace's runtime settings, feeding two collaborators: the opt-in review-debt
    // friction guard on task creation (paired with the open-notification reader below), and the
    // default test-environment provisioning stamped onto a new service frame. Optional seam —
    // when a facade doesn't wire settings, both are pass-throughs.
    workspaceSettings: settings?.service,
    reviewFrictionNotifications: notifications?.service,
  })
  const workspaceService = new WorkspaceService({
    ...dependencies,
    // The resolved (defaulted) pipeline registry, so a new workspace is seeded with the built-in
    // catalog + any deployment-registered pipelines (the raw `dependencies.pipelineRegistry` may be
    // undefined; this is the same instance the pipeline service reseeds from).
    pipelineRegistry,
    // A board delete drops its cached access decisions (workspace-rbac).
    workspaceAccessCache: caches.workspaceAccess,
    // Late-bound (the seeder is built after the foundation, over the environments module): `create`
    // seeds a new board's deployment-declared environment handlers. Absent seeder ⇒ no seeding.
    getEnvironmentHandlerSeeder,
    // Same late binding, same posture: `create` seeds the board's deployment-declared shared
    // stacks. Absent seeder ⇒ no seeding.
    getSharedStackSeeder,
  })
  // Workspace-RBAC roster + access-mode management (workspace-rbac, slice 5). Present only when
  // the member repository is wired (both facades wire it; tests/no-roster leave it absent, so the
  // members controller 503s). Every roster/access-mode write drops the board's access cache group.
  modules.build('workspaceMemberService', () =>
    dependencies.workspaceMemberRepository
      ? new WorkspaceMemberService({
          workspaceMemberRepository: dependencies.workspaceMemberRepository,
          workspaceRepository: dependencies.workspaceRepository,
          membershipRepository: dependencies.membershipRepository,
          userRepository: dependencies.userRepository,
          clock: dependencies.clock,
          workspaceAccessCache: caches.workspaceAccess,
          audit: dependencies.auditRecorder,
        })
      : undefined,
  )
  const accountService = new AccountService({
    accountRepository: dependencies.accountRepository,
    membershipRepository: dependencies.membershipRepository,
    userRepository: dependencies.userRepository,
    idGenerator: dependencies.idGenerator,
    clock: dependencies.clock,
    // Late-bound so the account service can invalidate the spend service's cached
    // account-budget limit on an account-budget edit (spendService is built after the foundation).
    onAccountBudgetChanged: (accountId) => getSpendService()?.invalidateAccountLimit(accountId),
    // A membership grant/role change alters board access across the account, so drop the
    // workspace-access cache wholesale (workspace-rbac — the coarse fallback for a rare write).
    onAccountMembershipChanged: () => caches.workspaceAccess.invalidateAll(),
    // Reject an account budget above the operator cap on write (late-bound: spendService
    // is built after the foundation, and the cap is a static deployment fact once it is).
    resolveAccountBudgetCap: () => getSpendService()?.budgetCaps().accountMonthlyLimitMax,
    // Membership, role and budget/settings edits are the account-admin actions the audit log
    // exists for. Required on `CoreDependencies`, so this is never accidentally absent.
    audit: dependencies.auditRecorder,
  })
  const userService = new UserService({
    userRepository: dependencies.userRepository,
    passwordHasher: dependencies.passwordHasher,
    idGenerator: dependencies.idGenerator,
    clock: dependencies.clock,
  })
  const email = modules.build('email', () =>
    dependencies.emailConnectionRepository && dependencies.emailSecretCipher
      ? new EmailConnectionService({
          emailConnectionRepository: dependencies.emailConnectionRepository,
          secretCipher: dependencies.emailSecretCipher,
          clock: dependencies.clock,
        })
      : undefined,
  )
  modules.build('invitations', () =>
    dependencies.invitationRepository
      ? new InvitationService({
          invitationRepository: dependencies.invitationRepository,
          accountRepository: dependencies.accountRepository,
          membershipRepository: dependencies.membershipRepository,
          idGenerator: dependencies.idGenerator,
          clock: dependencies.clock,
          // Resolve the inviting account's own (DB-stored) email sender at send time.
          resolveEmailSender: email ? (accountId) => email.resolveSender(accountId) : undefined,
          appBaseUrl: dependencies.appBaseUrl,
          // Accepting an invitation grants membership ⇒ drop the workspace-access cache (workspace-rbac).
          onAccountMembershipChanged: () => caches.workspaceAccess.invalidateAll(),
          audit: dependencies.auditRecorder,
        })
      : undefined,
  )
  modules.build('passwordReset', () =>
    dependencies.passwordResetTokenRepository
      ? new PasswordResetService({
          passwordResetTokenRepository: dependencies.passwordResetTokenRepository,
          userRepository: dependencies.userRepository,
          passwordHasher: dependencies.passwordHasher,
          idGenerator: dependencies.idGenerator,
          clock: dependencies.clock,
          resolveSystemEmailSender: dependencies.resolveSystemEmailSender,
          appBaseUrl: dependencies.appBaseUrl,
          logger: dependencies.logger,
        })
      : undefined,
  )

  return { notifications, settings, boardService, workspaceService, accountService, userService }
}
