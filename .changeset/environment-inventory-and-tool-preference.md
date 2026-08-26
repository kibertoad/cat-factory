---
'@cat-factory/agents': minor
'@cat-factory/executor-harness': minor
'@cat-factory/local-server': patch
---

Tell an agent what its sandbox contains instead of making every one of them find out.

The dispatch used to instruct every container agent to discover its own environment ("probe for a tool before relying on it"), and every agent obeyed. In one measured run four calls out of a forty-call budget went on it twice over: an architect swept `docker kubectl helm kustomize` and then ran `docker info`, and the coder it handed off to rediscovered the same two answers thirty calls later. The harness holds all of it before the agent's first turn.

Ownership now splits along what each layer can know. The backend keeps the POLICY, which is true whatever the machine contains: no cluster or container-registry credentials, an artifact this environment cannot execute is still a correct artifact, and the limit is never a finding against the work. It names no tooling at all, because it is composed before a transport is chosen and the same job body serves the harness image, a deployment's own image variant and the developer's own machine under `LOCAL_NATIVE_AGENTS`. The harness probes once per job and appends an `ENVIRONMENT INVENTORY` block with the facts.

That block is three-valued, so a probe that failed renders as could-not-be-determined rather than as an absence, and it says in its last line that an unlisted tool is unknown rather than missing. The Docker DAEMON is answered by running `docker info`, never by finding the CLI: the image ships the CLI unconditionally and the rootless daemon it starts best-effort is what a run actually needs, which is why the old `command -v docker` answer was a half-truth. Composed at ONE point in `handleAgent`, onto the job's own system prompt, so every mode and all three agent CLIs inherit it and none carries it twice. The backend deliberately does not PROMISE the block: an image older than the backend appends none.

Two smaller prompt changes ride along. Every container dispatch now names a tool preference (file tools for file work, the shell for running things), because the models stopped reaching for their file tools on their own: four runs of one task in a three-day window used the write tool zero times, against 26 to 34 times per dispatch a fortnight earlier, rewriting whole files through shell heredocs instead. It is a nudge and nothing may depend on it. And the delivery contract now asks for a commit per coherent chunk rather than leaving the timing open, which bumps the build prompt to `build@v8`: the contract already said commits are published as they are made, but the checkpoint push can only publish what exists, and one killed run had made none in six and a half minutes.
