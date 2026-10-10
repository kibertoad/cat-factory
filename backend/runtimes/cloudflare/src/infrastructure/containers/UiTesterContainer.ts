import { RunContainer } from './RunContainer'

// One UI-TESTER container per run, mirroring {@link ExecutionContainer} but pulling the heavier
// UI image (`Dockerfile.ui`: the executor harness plus Playwright + Chromium, pnpm/yarn, the
// `serve` static server and a headless JRE + WireMock) instead of the plain executor image. A
// Cloudflare Container's image is pinned per container CLASS, so the `image: 'ui'` dispatch
// variant needs its own class; this one is bound as `UI_CONTAINER`, so the browser and the JRE
// never bloat the cold start of every coder/merger/ci-fixer run.
//
// It is a SECOND container for the same run rather than a replacement: a run mixes ordinary
// agent steps with a `tester-ui` step, and a per-run container cannot change image mid-run. The
// two are addressed by `containerKeyForRef`, which qualifies the run id with the variant.
//
// The UI image serves the SAME `POST /jobs` + `GET /jobs/{id}` contract on the same port (it layers onto
// the same harness), so the generic `CloudflareContainerTransport` drives it unchanged, and its
// lifecycle behaviour is {@link RunContainer}'s, shared byte-for-byte with the agent one.
export class UiTesterContainer extends RunContainer {}
