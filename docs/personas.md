# Personas

**Status:** draft for discussion. It defines the personas the product supports out of the box, so
they can guide what each surface shows.

This doc defines who uses cat-factory, which jobs each of them comes to do, and which surface each
one should land on. A new user-facing surface checks it before it decides its narrowing (the role
and the interface tier, see [`frontend/app/README.md`](../frontend/app/README.md#roles-engineer--product-manager--designer)).
It is not authorization: what a person may do stays with account roles and workspace RBAC
([ADR 0025](../backend/docs/adr/0025-workspace-rbac.md)).

## Summary

| Persona          | Comes to                                                  | Should land on                                          | Never configures                  |
| ---------------- | --------------------------------------------------------- | ------------------------------------------------------- | --------------------------------- |
| Product engineer | Ship product work through the factory                     | The delivery surface (the queue)                        | Deployment infrastructure         |
| Factory engineer | Make the factory ship more with fewer human steps         | The factory surface                                     | Deployment infrastructure         |
| Product manager  | Bring customer needs in, settle requirements, see results | A product surface (intake plus the requirements phases) | Models, pipelines, infrastructure |
| Designer         | Hand a design off as work, and follow it to the result    | The intake surface                                      | Anything beyond a design source   |
| Lead             | See what shipped, what it cost, and where work is stuck   | A read view of results and spend                        | Anything                          |
| Operator         | Keep the deployment able to run a task at all             | The setup area                                          | Product work                      |

The product engineer and the factory engineer are **one person with two jobs**, not two people. The
other four are different people.

## The jobs

The jobs come from the UX assessment behind [#2258](https://github.com/kibertoad/cat-factory/issues/2258):

| Job                | The sentence the user would say                   | Whose job                      |
| ------------------ | ------------------------------------------------- | ------------------------------ |
| J1 Intake          | "Get this done. Here is what I want."             | Product engineer, PM, designer |
| J2 Attention       | "What needs me right now?"                        | Product engineer, PM           |
| J3 Trust and merge | "Show me what changed and why I should merge it." | Product engineer               |
| J4 Get to green    | "Make the platform able to run a task at all."    | Operator                       |
| J5 Tune            | "Change how agents work on my code."              | Factory engineer               |

Two jobs the assessment did not name, added here:

| Job                    | The sentence the user would say                   | Whose job |
| ---------------------- | ------------------------------------------------- | --------- |
| J6 Settle requirements | "Make sure we build the right thing before code." | PM        |
| J7 Oversee             | "What shipped, what did it cost, what is stuck?"  | Lead      |

## The personas

### Product engineer

Uses the factory to ship the product: writes the request, answers what a run asks, reviews and
merges. Jobs J1, J2 and J3, many times a day.

- **Lands on:** the queue, with the board as a second view (the #2258 decision).
- **Needs:** one-sentence intake, the decisions and approvals waiting on them, the outcome window
  and the merge.
- **Does not need on this surface:** pipeline authoring, agent options with raw values, model and
  infrastructure setup. Today the basic tier still shows most of them (UXA-04, UXA-28).

### Factory engineer

The same engineer's second job: make the factory better. Measures how much work ships with no human
step and what it costs, finds each point where a person had to step in, and changes pipelines,
standards, prompts and models so that it happens less. Job J5. The factory job is the one that
makes the product job cheaper over time, and each human step is a failure of the factory to learn
from.

- **Lands on:** a factory surface. The proposal is to make the interface tier the switch between the
  two jobs, so the tier says which job, not how much of the product (see
  [Encoding](#how-personas-should-be-encoded)).
- **Needs:** the pipeline builder, Kaizen, the sandbox, fragment defaults, merge thresholds,
  foundational services, and measures: the share of tasks that ship with no human step, the cost per
  merged task, and the human steps grouped by step and reason.
- **Gap:** none of those measures exists. `agent_runs` records `status`, `failure` and
  `redrive_count`, but the gates and decisions a person answered are not in a column one query can
  count, so the measures need a new projection.

### Product manager

Brings customer input in, defines the feature, and takes part in settling the requirements before
code is written. Jobs J1, J2 and J6. In most teams a PM does not configure models, pipelines or
infrastructure. A technical PM who does can pick the engineer role.

- **Lands on:** a product surface: the intake surface plus the requirements phases.
- **Needs:** intake from a sentence or a ticket; the requirement review and brainstorm
  conversations; the outcome window; what shipped.
- **Already modelled in the backend, not in the SPA.** Three places know about a product person:
  - the account role `product` (`AccountRole` is `admin | developer | product`,
    `contracts/src/accounts.ts`);
  - the task's responsible product person, notified when requirement review flags findings
    (`TaskRunSettings.vue`);
  - the Product / Engineering choice on each person in the Slack member mapping: Product people are
    @-mentioned on requirement-review findings (`contracts/src/slack.ts`).

  The SPA's `product-manager` role ignores all three and maps to `full`, the engineer's surface
  (`ROLE_SURFACES` in `utils/uiRole.ts`).

- **Gaps today:**
  - On `full`, a PM meets pipeline names (UXA-26), operator failure text (UXA-27), the approval
    rail's run metadata (UXA-20) and the setup destinations (UXA-28).
  - On `intake`, a PM can answer a requirement review or a brainstorm when a run parks on one (both
    open as result views of the run step, with no role gate). But requirement review runs only in
    Complex build, and the two brainstorm steps are opt-in steps that need the pipeline builder,
    which `intake` hides. Initiatives, which run the planning pipelines, are advanced-only, and
    `intake` caps the tier at basic.
  - The frame header's bug hunt is described in its own code comment as "the engineer/PM judgement
    call", but it is hidden from `intake` (`BlockNode.vue`).

### Designer

Hands a design off as work and follows it to the result. Jobs J1 and part of J2. The designer role
is for **handoff**. Cat-factory does not support iterating on a UI today (no fast loop on a running
app), so the role must not promise design work.

- **Lands on:** the intake surface.
- **Needs:** "Start from a design", the work in flight, the outcome window with its screenshots.
- **Gaps today:** with no design source connected, the designer has no route to start from a
  design, and `intake` has no Integrations entry to connect one (UXA-05; the reduced Integrations
  list for intake was agreed in #2254 and has not landed). The role hint says "new tasks from a
  design or a ticket", which reads as design work; reword it to a handoff ("File new work from a
  design or a ticket, and follow it to the result.").

### Lead

An engineering lead or a stakeholder who oversees the work without doing it. Job J7: what shipped,
what it cost, what is stuck. The UX assessment behind #2258 already lists this persona.

- **Lands on:** a read view of results and spend.
- **Needs:** a list of what shipped (task, service, merge date, the outcome window), spend for the
  boards they own, and the work that waits on a person.
- **Gaps today:** the queue shows only a count of merges in the Done-lane retention window
  (UXA-33). Reports needs the advanced tier and account admin (`nav-contributions.ts`, `reports`).
  This needs **more granular permissions**, so it is an RBAC change first
  (ADR 0025 has `admin | member | viewer` per workspace and no permission for reading spend), and a
  surface second.

### Operator

Runs the deployment: model providers, the agent executor, environments, storage, SSO. Job J4, once
and then rarely. Often a platform team, not a user of the boards.

- **Lands on:** the setup area: the setup checklist, then the screens each row opens.
- **Needs:** the setup checklist, Infrastructure, Model providers, Integrations, the operator
  dashboard, local models.
- **Gaps today:** the operator's screens sit in the everyday sidebar for every engineer, in the
  basic tier too (UXA-28), and the startup advisories reach every role (UXA-03, #2328). #2429
  proposes one setup checklist instead of banners.

## How personas are encoded today

Three separate definitions, none derived from another:

| Where                                      | Vocabulary                                                   | Decides                                                    |
| ------------------------------------------ | ------------------------------------------------------------ | ---------------------------------------------------------- |
| The SPA role question                      | engineer, product-manager, designer → `full` or `intake`     | Which sidebar destinations show                            |
| The interface tier                         | basic, advanced                                              | Override fields and power-user destinations                |
| Account roles and the Slack member mapping | admin, developer, product; Product or Engineering per person | Permissions, notifications, the responsible product person |

So "engineer" holds two jobs on one surface, the PM gets the engineer's surface, the backend's
`product` person never reaches the SPA's role, and the lead and the operator have no role at all.

## How personas should be encoded

A proposal, for the maintainer to accept or change:

1. **The role question picks the person.** Engineer, product manager, designer, each with its own
   surface. Once the PM's surface differs, the question has a reason to exist at launch, which
   affects #2429's option A (questions A1 and A2).
2. **The account role answers it when it can.** `product` without `developer` means "Product
   manager", `developer` means "Engineer", and the question opens only when the account roles do
   not decide. The person can switch from the sidebar either way.
3. **`RoleSurface` grows from `full | intake` to `intake | product | delivery | factory`:**
   - `intake`: the designer (handoff).
   - `product`: the PM. Intake, plus the requirements phases: the requirement review and
     brainstorm steps offered at intake (not only in the builder), the outcome window, a
     "Shipped" list.
   - `delivery` and `factory`: the two jobs of the engineer. The interface tier becomes the switch
     between them, so basic means "ship product" and advanced means "improve the factory".
4. **The lead is a permission plus a view, not a role surface.** A read permission for results and
   spend below account admin (RBAC), and a read view that uses it.
5. **The operator is the setup area, not a role surface.** Operator screens leave the everyday
   sidebar and are reached from the setup checklist, gated by the permissions that already exist
   (`canManageIntegrations` and the like).

## Open questions

Grouped by the decision each one blocks, in the order the decisions depend on each other: the
roles come first because every surface hangs off them. Each question has a suggested answer.

### A. Roles and the question at launch

1. **Does the role question still open at launch?** #2429 proposes it does not (option A), because
   today two of its three answers give the same surface. Once the PM has a surface of its own, an
   unasked PM lands on the engineer's.
   _Suggested:_ ask at launch only when the account roles do not decide it (see 2), after the setup
   checklist and before the tour offer. This changes #2429's option A; decide both together.
2. **Does the account role preselect the answer?** The backend already knows a `product` person.
   _Suggested:_ yes. Account roles `product` without `developer` preselect "Product manager",
   `developer` preselects "Engineer", and the question is skipped when exactly one applies. The
   person can still switch from the sidebar. A deployment without accounts (local mode) always asks.
3. **Does the lead get an answer in the role question?**
   _Suggested:_ not yet. The lead's need is a permission and a read view (D). A role surface for
   the lead is worth adding once that view exists and something else differs.

### B. The PM's surface

4. **A `product` surface of its own, or `intake` plus the requirements phases?**
   _Suggested:_ its own surface from the start. It already differs from the designer's in three
   places: the requirements phases (5), the bug hunt (triage, which its code calls "the
   engineer/PM judgement call"), and the "Shipped" list (D). The cost is in the nav model, not the
   `Record`: today a destination opts in with one boolean, `intake: true`, so a third surface needs
   that flag to become a list of surfaces, and the tour requirements that derive from it follow.
5. **Which requirements phases does a PM start, and which only answer?**
   _Suggested:_ a PM starts them at intake: "Settle the requirements first" and "Brainstorm a
   direction first" as choices in Describe new work, so neither needs the pipeline builder or
   Complex build. A PM answers them through the queue, as today, and stays the task's responsible
   product person, so the existing notifications reach them.

### C. What the interface tier means

6. **Does the tier become the switch between the engineer's two jobs** (basic: ship product,
   advanced: improve the factory)?
   _Suggested:_ yes, for the engineer only; the PM and the designer stay capped at their surface,
   as `intake` is today. This changes what the website says the tier is, so it needs a website PR,
   and the README's tier rule gains the job reading.
7. **Where do merge thresholds and risk policies go?** A factory engineer tunes them; a lead may own
   them.
   _Suggested:_ the factory surface, gated by `settings.manage`, which a lead with workspace admin
   already holds. The lead reads them in the view from D.
8. **Only once the factory surface is accepted:** the first measures. _Suggested:_ automation rate
   counts only steps a person took (an answered decision, an approval, a manual retry or merge); the
   platform's own retries are reported beside it, not inside it. In the UI use job words ("Improve
   how agents work"), and keep "factory engineer" for the docs and the website.

### D. Operator and lead permissions

9. **Do the operator's screens leave the everyday sidebar?**
   _Suggested:_ yes, into the setup area that #2429 proposes, opened from the setup checklist and
   gated by the permissions that already exist (`integrations.manage`, `secrets.manage`,
   `settings.manage`). No new role.
10. **Which permission lets someone below account admin see what shipped and what it cost?** It
    needs more granular permissions than exist today.
    _Suggested:_ split it in two. "What shipped" (the Shipped list with the outcome windows) needs
    only `workspace.read`, so every member and viewer sees it. "What it cost" for one board becomes
    a new workspace permission held by workspace admins, so a lead with workspace admin sees spend
    without being account admin. Account-wide Reports stays with account admins. The new permission
    is an additive member of the `WorkspacePermission` catalog in ADR 0025.

## Related

- [#2429](https://github.com/kibertoad/cat-factory/issues/2429): the first minute, which proposes no
  role question at launch.
- [UX assessment](./initiatives/ux-assessment-2026-09.md): UXA-03, UXA-04, UXA-05, UXA-20 and
  UXA-26 to UXA-28, the findings these personas explain.
- [Delivery surface](./initiatives/delivery-surface.md): slice 6 (the role prompt) is where these
  decisions land.
- [`frontend/app/README.md`](../frontend/app/README.md#roles-engineer--product-manager--designer):
  how the role and the tier are implemented today.
