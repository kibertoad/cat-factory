import { defineConfig } from './src/config'

// Example benchmark matrix. Copy to `bench.config.ts` and edit. Switching a model
// or a prompt version is a one-line change here — no code edit.
//
// Models resolve through the NodeModelProvider:
//   - workers-ai  → Cloudflare REST (needs CF_ACCOUNT_ID + CF_API_TOKEN) — runs
//                   locally while still using Cloudflare AI.
//   - anthropic / openai / qwen / deepseek / moonshot → their *_API_KEY.
// The implementation task additionally needs the `pi` CLI on PATH.

export default defineConfig({
  name: 'example',
  // Compare two models...
  models: [
    {
      label: 'cf-llama',
      ref: { provider: 'workers-ai', model: '@cf/meta/llama-3.1-8b-instruct' },
    },
    // { label: 'claude', ref: { provider: 'anthropic', model: 'claude-sonnet-4-6' } },
    //
    // CACHING DIMENSION — route the SAME model through a cache-capable flavour vs the
    // cache-less Workers-AI flavour to see which actually caches (the report's "Cache
    // hit" column reports >0% only when the provider serves cached prompt tokens) and
    // the latency delta on a repeated-prefix run. The hot-path defaults run on
    // workers-ai (no caching); a direct key upgrades the same model to a caching route.
    //   { label: 'qwen-direct (cache)', ref: { provider: 'qwen', model: 'qwen3-max' } },
    //   { label: 'qwen-cf (no cache)',  ref: { provider: 'workers-ai', model: '@cf/qwen/qwen3-30b-a3b-fp8' } },
  ],
  // ...across the requirement-review and code-review tasks.
  tasks: ['requirement-review', 'code-review'],
  // Prompt variants per task. Omit a task to use its built-in versioned prompt.
  // Here we pit the shipped reviewer prompt (review@v1) against an experimental
  // terser variant (review@v2) to measure the prompt-version impact.
  prompts: {
    'code-review': [
      { promptId: 'review' }, // built-in review@v1
      {
        promptId: 'review',
        version: 2,
        system:
          'You are a terse senior reviewer. List only blocker- and major-severity findings, each one line, most severe first. Reference the exact code. If the work is sound, say "LGTM" and stop.',
      },
    ],
  },
})
