---
---

Docs: add `backend/docs/model-support.md`, a dedicated reference for model
selection, the Cloudflare → direct → subscription fallback ladder ("subscriptions
always win"), the Pi / Claude Code / Codex harnesses and the inline degradation
seam, dual-mode vs subscription-only catalog entries and context windows, the
flat-rate-quota vs spend-budget interplay, the individual-only (Claude-on-org)
rule, and the per-runtime provisioning/env reference (direct keys,
Cloudflare-over-REST, Bedrock allow-list, `ENCRYPTION_KEY`). Link it from the
README feature guide + documentation index, and refresh the now-stale backend
"Model picker and provider keys" section to cover subscriptions and point to the
new page. Docs only — no code or package changes.
