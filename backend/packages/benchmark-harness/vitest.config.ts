import { defineConfig } from 'vitest/config'

// Plain node-environment unit tests. The LLM and the Pi run are faked, so the
// suite is fast and offline — it exercises matrix expansion, prompt/model
// resolution, grading artifact emission and the grades-merge/report logic.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
})
