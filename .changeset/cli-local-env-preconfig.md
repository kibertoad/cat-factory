---
'@cat-factory/cli': minor
---

`cat-factory init` now offers richer `.env` preconfiguration for local mode: it offers to
generate `AUTH_SESSION_SECRET` / `ENCRYPTION_KEY` (on by default, decline to paste your own),
lets you choose between a **prewarmed Docker pool** and **native host agents** (with the
tradeoffs printed and the applicable native models listed for the native path), and surfaces the
commonly-useful optional settings (auth, Langfuse, Slack, consensus, image refresh) commented with
sane defaults — each annotated with its actual default (so the opt-in knobs aren't mistaken for
on-by-default). New flags: `--execution-mode`, `--native-harnesses`, `--harness-entry`. A
native-only flag with no `--execution-mode` now infers native mode (and passing one under `pool`
warns instead of silently dropping it), and `--yes --execution-mode native` warns when
`LOCAL_HARNESS_ENTRY` is left blank.
