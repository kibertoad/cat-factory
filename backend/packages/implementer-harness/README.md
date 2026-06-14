# @cat-factory/implementer-harness

The payload that runs **inside** a per-run Cloudflare Container to perform real
code implementation with the [Pi coding agent](https://github.com/earendil-works/pi).

It is a thin TypeScript wrapper (a `node:http` server on `:8080`) that the
Worker's `ContainerAgentExecutor` drives via `POST /run`:

1. **clone** the target repo (shallow) with a short-lived GitHub installation token,
2. write the composed system prompt (role + the block's best-practice fragments)
   to `AGENTS.md`, and point Pi at the Worker's LLM proxy via
   `~/.pi/agent/models.json` (provider `proxy`, `api: openai-completions`),
3. **run Pi** non-interactively (`pi -p --mode json --model proxy/<model> --approve`),
4. **commit, push** a branch and **open a PR**, returning `{ prUrl, summary }`.

## No secrets in the image

The image (built from the `Dockerfile`, base `node:26-trixie-slim`) contains
only `git` + the Pi CLI + this compiled wrapper — **no API keys, no GitHub
credentials**. Per job, the Worker passes a short-lived GitHub token and a
signed, model-locked LLM-proxy **session token** in the request body. Pi reaches
models only through the Worker proxy, which injects the real provider key (qwen /
Kimi / DeepSeek) and meters spend. The provider key never enters the container.

## Layout

| File            | Responsibility                                                 |
| --------------- | -------------------------------------------------------------- |
| `src/server.ts` | HTTP entry point; orchestrates clone → Pi → commit → push → PR |
| `src/job.ts`    | `/run` request type + validator                                |
| `src/pi.ts`     | Pi provider config + non-interactive run + output parsing      |
| `src/git.ts`    | clone / branch / commit / push + GitHub PR creation            |

## Build / test

```sh
pnpm --filter @cat-factory/implementer-harness build      # tsc → dist/
pnpm --filter @cat-factory/implementer-harness test       # unit tests
docker build -f Dockerfile .                              # the container image
```

The Worker references this `Dockerfile` from its `wrangler.toml`
(`[[containers]] image = "../implementer-harness/Dockerfile"`); the build context
is just this package, so its `tsconfig.json` is intentionally self-contained.
