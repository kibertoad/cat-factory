---
'@cat-factory/cli': minor
---

`cat-factory init` now offers richer `.env` preconfiguration for local mode: it offers to
generate `AUTH_SESSION_SECRET` / `ENCRYPTION_KEY` (on by default, decline to paste your own),
lets you choose between a **prewarmed Docker pool** and **native host agents** (with the
tradeoffs printed and the applicable native models listed for the native path), and surfaces the
commonly-useful optional settings (auth, Langfuse, Slack, consensus, image refresh) commented with
sane defaults. New flags: `--execution-mode`, `--native-harnesses`, `--harness-entry`.
