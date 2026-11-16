// The PROJECTS tag's component schemas and operation docs (project kinds, definitions, projects,
// project tasks, outcomes) and the credential resume. generate-openapi.mjs spreads them in; they
// live here so that file stays inside its size budget.

/**
 * The surface's hoisted component schemas, each named so a generated client reads the type by
 * name. Keyed like `COMPONENT_SCHEMAS`: the component name and the contracts export it renders.
 */
export const PROJECT_COMPONENT_SCHEMAS = {
  PublicProjectKind: 'publicProjectKindSchema',
  PublicProjectKindList: 'publicProjectKindListSchema',
  PublicProjectKindDetail: 'publicProjectKindDetailSchema',
  PublicProjectDefinition: 'publicProjectDefinitionSchema',
  PublicProjectDefinitionList: 'publicProjectDefinitionListSchema',
  PublishProjectDefinition: 'publishProjectDefinitionSchema',
  PublicProjectPin: 'publicProjectPinSchema',
  PublicProject: 'publicProjectSchema',
  PublicProjectList: 'publicProjectListSchema',
  CreatePublicProject: 'createPublicProjectSchema',
  PublicProjectServices: 'publicProjectServicesSchema',
  PublicProjectTask: 'publicProjectTaskSchema',
  PublicProjectTaskList: 'publicProjectTaskListSchema',
  CreatePublicProjectTask: 'createPublicProjectTaskSchema',
  PublicProjectOutcome: 'publicProjectOutcomeSchema',
  PublicProjectOutcomeList: 'publicProjectOutcomeListSchema',
  PublicProjectView: 'publicProjectViewSchema',
  PublicCredentialResume: 'publicCredentialResumeSchema',
}

const OPAQUE =
  'The platform never reads it: the project kind owns its shape and serves its JSON Schema from `GET /api/v1/project-kinds/{kind}`.'

/** Operation docs for the projects surface, keyed by operationId like `OPERATION_DOCS`. */
export const PROJECT_OPERATION_DOCS = {
  listPublicProjectKinds: {
    tag: 'Projects',
    summary: 'List the project kinds the deployment offers',
    description:
      'Each kind with the task types its projects take and whether a project of it pins a definition (`definition`: `required` or `optional`; absent for a kind that pins none). The built-in kind is `research`; a deployment registers its own.',
  },
  getPublicProjectKind: {
    tag: 'Projects',
    summary: 'Get a project kind with its schemas',
    description:
      "One kind with the JSON Schemas of the shapes the rest of this surface leaves opaque: a definition's `spec`, an outcome's `body` (in the schema version the deployment writes) and a project's `view`. Each is null for a kind that declares none. A schema states the shape; a kind can enforce more when it parses (unique ids, say). An unknown kind is `404`.",
  },
  listPublicProjectDefinitions: {
    tag: 'Projects',
    summary: 'List the definitions of one kind the account can pin',
    description:
      "Every definition of the kind a project of the key's account can pin: the ones the deployment ships in code (`origin: registered`) and the ones the account published (`origin: stored`), each with its content hash. A definition's envelope names the credentials its runs need, the origins a credential may be sent to and the inputs a project fills; its `spec` says what the work is. " +
      OPAQUE,
  },
  getPublicProjectDefinition: {
    tag: 'Projects',
    summary: 'Get every version of one definition',
    description:
      'Every version of one definition key of the kind the account can pin, ascending. An unknown key is `404` with `details.reason: "project_definition_not_found"`.',
  },
  publishPublicProjectDefinition: {
    tag: 'Projects',
    summary: 'Publish a definition version',
    description:
      'Publish one immutable version of an account-owned definition; the kind, key and version are the path\'s. The envelope is checked by this schema and the `spec` by the kind, against the schema the kind serves; a spec the kind refuses, or a kind this deployment cannot validate, is `422` with `details.reason: "project_definition_invalid"` and `details.problems` listing each issue. A version already published is `409` with `project_definition_version_exists`, so a project pinned to it never changes meaning. A key in a namespace the deployment\'s own definitions of the kind use is `409` with `project_definition_key_registered`. A credential key the deployment reserves for its own configuration is refused `400` by the body schema. Requires an `admin` key: a definition names the credentials a run sends and the origins it may send them to.',
  },
  listPublicProjects: {
    tag: 'Projects',
    summary: "List the projects the key's workspace mounts",
    description:
      "Projects are account-owned peers of services, mounted onto boards. Each entry carries its linked services, whether the key's workspace is the board that homes it (`homedHere`, the board that creates and runs its tasks) and, for a kind that pins a definition, the version it pinned.",
  },
  createPublicProject: {
    tag: 'Projects',
    summary: 'Create a project',
    description:
      "Create a project homed on the key's workspace. A kind that pins a definition takes `definition` naming its key, an optional version (the highest by default) and the values for its `inputs`; the project pins that version and its content hash. Refusals are `422` with `details.reason`: `project_kind_unregistered`, `project_definition_required`, `project_definition_not_accepted`, `project_definition_not_found`, `project_definition_inputs_invalid`, `project_service_link_invalid`.",
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
      'A project task has its own resource, `PublicProjectTask`, carrying `projectId` where a service task carries `serviceId`. `taskType` defaults to the first type the project\'s kind offers, and what a task of that type asks for goes in `fields`, described by `GET /api/v1/task-types` (a `research` task takes its mode and ad-hoc questions there). A project\'s tasks are created and run on the board that homes it; any other board is refused with `409` and `details.reason: "project_homed_elsewhere"`.',
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
  listPublicProjectOutcomes: {
    tag: 'Projects',
    summary: "List a project's outcomes",
    description:
      "Every outcome the project's tasks recorded, without bodies, ordered by `seq`: the order the tasks were STARTED, across every stream. `stream` narrows to one stream. An outcome is immutable once written.",
  },
  getPublicProjectOutcome: {
    tag: 'Projects',
    summary: 'Get one outcome with its body',
    description:
      'One outcome with the body its task recorded, wherever it is stored. ' +
      OPAQUE +
      ' An offloaded body that cannot be read is `503` with `details.reason: "outcome_body_unavailable"` rather than an empty one.',
  },
  getPublicProjectView: {
    tag: 'Projects',
    summary: "Get a project's current view",
    description:
      "The project's current state as its kind reads every outcome (for `research`: the findings folded by question, with coverage of the pinned definition). " +
      OPAQUE +
      ' `view` is null for a kind that computes none; read its outcomes instead. A body that cannot be read is `503` with `outcome_body_unavailable`.',
  },
  resumePublicRunCredential: {
    tag: 'Decisions',
    summary: 'Resume a run parked on a missing credential',
    description:
      'Resume a run parked because a step needs a capability credential (a vendor login, say) that was not stored. Store it first through the capability-credentials settings; a resume while the key still does not resolve is `409` with `details.reason: "capability_credential_still_missing"`. A wait on a lapsed personal credential is `409` with `credential_wait_personal_in_app`: only the run\'s initiator renews it, in the app. Requires a `decide` key.',
  },
}
