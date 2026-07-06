---
'@cat-factory/node-server': patch
---

Honour `INITIATIVE_LOOP_INTERVAL_MS` when it is supplied through `start({ env })`. The initiative-
loop sweeper resolved its interval from `process.env` directly, but `start()` takes its config from
an injected `env` object it never writes back to `process.env` — so a deployment (or the e2e
backend) that set the knob via the injected env was silently ignored and the loop ran at the 60s
backstop. `resolveSweepInterval(env)` now reads the passed env and `start()` threads its own `env`
through. This deflakes an intermittent e2e failure where an initiative's first task spawn (which,
absent a terminal poke, waits for the sweep) landed ~60s later — past the spec's timeout.
