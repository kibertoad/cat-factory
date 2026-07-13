---
'@cat-factory/server': patch
'@cat-factory/node-server': patch
'@cat-factory/worker': patch
---

Warn when a numeric env knob is set to a non-numeric value (error-message initiative A8).

Numeric knobs are read as `num(env.SOME_VAR) ?? default`. A garbage value (`JOB_MAX_POLLS=abc`,
a stray unit like `30s`, a trailing comma) used to coerce silently to `undefined`, so the
caller's `?? default` swallowed the typo with no signal — the operator saw the built-in default
in effect and no clue their override was ignored.

- New shared `parseNumericEnv(name, value)` in `@cat-factory/server` emits ONE structured
  warning (var name, rejected value, docs link) when a PRESENT value is not a finite number,
  before falling back to the default. An unset/blank var stays silent (the default is the
  intended behaviour there), and a valid value is unchanged.
- Both facades' local `num()` helpers (Node `config.ts` + `execution/config.ts`, Worker
  `infrastructure/config/utils.ts` — the Worker's `retentionMs` too) now delegate to it, so the
  warning reads identically across runtimes. The message lives in one shared place per the
  "keep the runtimes symmetric" rule.
- The two knobs read at every model-config site (`AGENT_DEFAULT_TEMPERATURE`,
  `AGENT_MAX_OUTPUT_TOKENS`) are now parsed ONCE per facade and reused, so a single garbage value
  emits one warning rather than one per read site.
- Node's retention days now go through a local `retentionMs` helper mirroring the Worker's,
  including the `days >= 0` clamp — a negative override falls back to the default on both facades
  instead of yielding a negative window on Node only.
