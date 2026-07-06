---
'@cat-factory/local-server': minor
---

Run inline LLM steps on a subscription-only model by default in local and mothership mode.

A preset that pins everything to a subscription-only model (e.g. `claude-opus`) used to be
refused at pipeline start with `preset_unsatisfiable` unless you also enabled
`LOCAL_NATIVE_AGENTS`, which runs whole container agents unsandboxed. The inline steps
(requirements reviewer, brainstorm, task-estimator, inline document kinds) are one-shot text
calls with no repo checkout or tools, so they now run on the developer's ambient `claude` /
`codex` CLI by default, via a dedicated `LOCAL_NATIVE_INLINE` flag (default on) that is
decoupled from the container-native opt-in. Set `LOCAL_NATIVE_INLINE=off` to disable, or list a
subset (e.g. `claude-code`) to restrict which vendors are inline-eligible. Only the native
vendors (`claude` / `codex`) are eligible; a non-native vendor reusing the `claude-code` harness
(GLM / Kimi / DeepSeek) still degrades to a provider model for inline steps.
