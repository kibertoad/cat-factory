// Pure document-authoring vocabulary shared by the agent-kind definitions
// (`@cat-factory/agents`), the execution engine (`@cat-factory/orchestration`)
// and the facades — mirroring `initiative-logic.ts` / `gate-logic.ts` so no
// package has to depend on another just for the kind string.

/**
 * The interactive-review INTERVIEWER — an inline LLM (no container) that
 * converses with the human about a document's scope / audience / structure
 * between the outline and the written draft, parking the run on a durable
 * decision-wait until they answer. WS5 of the document-task initiative.
 */
export const DOC_INTERVIEWER_AGENT_KIND = 'doc-interviewer'
