import { RunContainer } from './RunContainer'

// One DEPLOY container per run (addressed by the run id), mirroring {@link ExecutionContainer}
// but pulling the SEPARATE deploy-harness image (slim base + real `kubectl`/`kustomize`/`helm`)
// instead of the executor-harness: a Cloudflare Container's image is pinned per container
// class, so the `image: 'deploy'` dispatch variant needs its own class. This one is bound as
// `DEPLOY_CONTAINER`, so the k8s CLIs never bloat an agent run's cold start.
//
// The deploy harness serves the SAME `POST /jobs` + `GET /jobs/{id}` contract on 8080, so the
// generic `CloudflareContainerTransport` drives it unchanged (it just gets this namespace), and
// its lifecycle behaviour is {@link RunContainer}'s, shared byte-for-byte with the agent one.
export class DeployContainer extends RunContainer {}
