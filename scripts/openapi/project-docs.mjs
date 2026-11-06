// The PROJECTS tag's component schemas and operation docs (research definitions, projects, project
// tasks, findings) and the credential resume. generate-openapi.mjs spreads them in; they live here
// so that file stays inside its size budget.

/**
 * The surface's hoisted component schemas, each named so a generated client reads the type by
 * name. Keyed like `COMPONENT_SCHEMAS`: the component name and the contracts export it renders.
 */
export const PROJECT_COMPONENT_SCHEMAS = {
  PublicResearchDefinition: 'publicResearchDefinitionSchema',
  PublicResearchDefinitionList: 'publicResearchDefinitionListSchema',
  PublishResearchDefinition: 'publishResearchDefinitionSchema',
  PublicResearchPin: 'publicResearchPinSchema',
  PublicProject: 'publicProjectSchema',
  PublicProjectList: 'publicProjectListSchema',
  CreatePublicProject: 'createPublicProjectSchema',
  PublicProjectServices: 'publicProjectServicesSchema',
  PublicProjectTask: 'publicProjectTaskSchema',
  PublicProjectTaskList: 'publicProjectTaskListSchema',
  CreatePublicProjectTask: 'createPublicProjectTaskSchema',
  PublicFoldedFinding: 'publicFoldedFindingSchema',
  PublicProjectFindings: 'publicProjectFindingsSchema',
  PublicFindingsRevision: 'publicFindingsRevisionSchema',
  PublicCredentialResume: 'publicCredentialResumeSchema',
}

/** Operation docs for the projects surface, keyed by operationId like `OPERATION_DOCS`. */
export const PROJECT_OPERATION_DOCS = {
  listPublicResearchDefinitions: {
    tag: 'Projects',
    summary: 'List the research definitions the account can pin',
    description:
      "Every research definition a research project of the key's account can pin: the ones the deployment ships in code (`origin: registered`) and the ones the account published (`origin: stored`), each with its content hash. A definition says what to find out (topics and questions), which credentials the research needs by name, and the vendor origins a credential may be sent to.",
  },
  getPublicResearchDefinition: {
    tag: 'Projects',
    summary: 'Get every version of one research definition',
    description:
      'Every version of one definition key the account can pin, ascending. An unknown key is `404` with `details.reason: "research_definition_not_found"`.',
  },
  publishPublicResearchDefinition: {
    tag: 'Projects',
    summary: 'Publish a research definition version',
    description:
      'Publish one immutable version of an account-owned research definition; the key and version are the path\'s. A version already published is `409` with `details.reason: "research_definition_version_exists"`, so a project pinned to it never changes meaning. A key in a namespace the deployment\'s own definitions use is `409` with `research_definition_key_registered`. A credential key the deployment reserves for its own configuration is refused `400` by the body schema. Requires an `admin` key: a definition names the credentials a run sends and the origins it may send them to.',
  },
  listPublicProjects: {
    tag: 'Projects',
    summary: "List the projects the key's workspace mounts",
    description:
      "Projects are account-owned peers of services, mounted onto boards. Each entry carries its linked services, whether the key's workspace is the board that homes it (`homedHere`, the board that creates and runs its tasks) and, for a research project, the definition version it pinned.",
  },
  createPublicProject: {
    tag: 'Projects',
    summary: 'Create a project',
    description:
      "Create a project homed on the key's workspace. A kind keeping research data (the built-in `research` kind) takes `research` naming the definition key, an optional version (the highest by default) and the values for its `inputs`; the project pins that version and its content hash. Refusals are `422` with `details.reason`: `project_kind_unregistered`, `research_pin_required`, `research_pin_not_accepted`, `research_definition_not_found`, `research_inputs_invalid`, `project_service_link_invalid`.",
  },
  getPublicProject: { tag: 'Projects', summary: 'Get a project' },
  linkPublicProjectServices: {
    tag: 'Projects',
    summary: 'Link services to a project',
    description:
      "Link services of the project's own account as read-only context for its tasks. Services already linked stay linked.",
  },
  unlinkPublicProjectServices: {
    tag: 'Projects',
    summary: 'Unlink services from a project',
    description: 'A service the project does not link is ignored.',
  },
  mountPublicProject: {
    tag: 'Projects',
    summary: "Mount a project on the key's workspace",
    description:
      "Mount a project of the key's account onto the key's workspace, so its reads are served there. Idempotent.",
  },
  listPublicProjectTasks: { tag: 'Projects', summary: "List a project's tasks" },
  createPublicProjectTask: {
    tag: 'Projects',
    summary: 'Create a task under a project',
    description:
      'A project task has its own resource, `PublicProjectTask`, carrying `projectId` where a service task carries `serviceId`. `taskType` defaults to the first type the project\'s kind offers. A `research` task takes its mode (`initial`, `extend`, `clarify`, `refresh`) and ad-hoc questions through `fields`. A project\'s tasks are created and run on the board that homes it; any other board is refused with `409` and `details.reason: "project_homed_elsewhere"`.',
  },
  getPublicProjectTask: { tag: 'Projects', summary: 'Get a project task' },
  startPublicProjectTask: {
    tag: 'Projects',
    summary: 'Start a project task',
    description:
      "Start the task's run under the same admission as `POST /api/v1/tasks/{taskId}/start`: a pipeline that can park on a person needs a `decide` key, and an individual-usage model needs the personal-unlock headers.",
  },
  stopPublicProjectTask: { tag: 'Projects', summary: 'Stop a project task' },
  retryPublicProjectTask: { tag: 'Projects', summary: 'Retry a project task' },
  getPublicProjectFindings: {
    tag: 'Projects',
    summary: "Get a research project's findings",
    description:
      "The project's current findings: every revision folded by question id in the order the tasks started. A newer answered or partial answer replaces an older one; a newer unanswered or blocked attempt is kept beside it as a note and never erases it. Coverage is computed by the platform from the agent's per-question judgements. A project pinning no definition is `422` with `research_project_not_pinned`.",
  },
  getPublicFindingsRevision: {
    tag: 'Projects',
    summary: 'Get one findings revision',
    description:
      'One revision with the body its task recorded, wherever it is stored. An offloaded body that cannot be read is `503` with `details.reason: "findings_body_unavailable"` rather than an empty revision.',
  },
  resumePublicRunCredential: {
    tag: 'Decisions',
    summary: 'Resume a run parked on a missing credential',
    description:
      'Resume a run parked because a step needs a capability credential (a vendor login, say) that was not stored. Store it first through the capability-credentials settings; a resume while the key still does not resolve is `409` with `details.reason: "capability_credential_still_missing"`. A wait on a lapsed personal credential is `409` with `credential_wait_personal_in_app`: only the run\'s initiator renews it, in the app. Requires a `decide` key.',
  },
}
