---
'@cat-factory/contracts': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/app': minor
---

Complete the implementation-fork decision phase with grounded CHAT (PR 2 of the initiative).
Before the Coder writes code, a human parked on the surfaced forks can now ask questions about
them and get a grounded, comparative answer before deciding. Each human turn is answered by an
inline LLM in the durable driver (no container re-dispatch) over the fixed proposal grounding +
the thread; a `maxChatTurns` budget bounds spend, and with no chat model wired the chat degrades
to a canned "chat unavailable" reply so pick / custom still work. Adds the
`POST /executions/:id/fork-decision/chat` endpoint, the `fork-chat` prompt (v1), the
`ForkChatService`, the `pendingForkChat` re-entry protocol, the window chat thread, and the
cross-runtime + e2e coverage. The fork-decision initiative tracker is converted to ADR 0022.
