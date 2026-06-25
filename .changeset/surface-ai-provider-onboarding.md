---
'@cat-factory/app': patch
---

Surface the need to configure an AI model provider in the SPA. AI only works out of the box
on a Cloudflare deployment with Workers AI enabled; every other deployment must onboard a
source (provider key, pooled/personal subscription, OpenRouter/LiteLLM proxy, Bedrock, or a
local runner). Previously nothing told the user this — the model picker silently showed every
model as unselectable and tasks failed deep in the run.

Two new prompts, both driven by a `useAiReadiness` composable that reads the existing
per-workspace catalog `available` flag and the workspace's model presets (no backend change):

- **No usable AI source** → an auto-opening `AiProviderOnboardingModal` plus a persistent,
  dismissible `AiProvidersBanner`, explaining the situation and routing to each configuration
  panel (LLM vendors, OpenRouter, local runners; Bedrock/Workers AI noted as operator-level).
- **Default model preset references unavailable models** → an `AiPresetMismatchDialog` (and the
  banner's secondary state) offering to edit/switch the preset or configure vendors, plus an
  inline warning in the task inspector's model-preset picker (`TaskRunSettings`).

The per-workspace model catalog is now loaded on workspace-ready (it was lazily loaded per
component) so the readiness signals are populated regardless of which picker mounts; both
prompts clear themselves automatically once a usable source / valid preset exists.
