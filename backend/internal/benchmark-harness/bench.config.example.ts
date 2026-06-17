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
