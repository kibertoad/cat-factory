import { defineConfig } from './src/config'

// Example smoketest matrix. Copy to `smoke.config.ts` and edit. A smoketest runs
// each model across each coding fixture through the REAL Pi setup (the same flow
// the container uses), captures the whole transcript, and analyses it for
// breakage / dead-ends / loops. It does not grade anything.
//
// Models resolve their Pi endpoint the same way the benchmark harness does:
//   - workers-ai  → Cloudflare REST OpenAI-compatible endpoint
//                   (needs CF_ACCOUNT_ID + CF_API_TOKEN) — runs locally while
//                   still using actual Cloudflare AI.
//   - openai / qwen / deepseek / moonshot → their *_API_KEY.
// The `pi` CLI must be on PATH. Run locally, never in CI.

export default defineConfig({
  name: 'example',
  models: [
    {
      label: 'cf-llama',
      ref: { provider: 'workers-ai', model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' },
    },
    // Add more candidates to compare how they cope with the same tasks:
    // { label: 'cf-qwen', ref: { provider: 'workers-ai', model: '@cf/qwen/qwen2.5-coder-32b-instruct' } },
  ],
  // Omit `fixtures` to run all built-in coding tasks; or restrict to some:
  // fixtures: ['healthcheck-endpoint'],
  //
  // Relax the live no-progress guard so a looping run is captured whole instead
  // of being killed at the guard threshold (useful when investigating a loop):
  // relaxGuard: true,
})
