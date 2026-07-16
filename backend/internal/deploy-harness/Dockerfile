# syntax=docker/dockerfile:1
#
# Deploy container image. Runs a thin TS wrapper that renders a service's Kubernetes
# manifests with real kubectl/kustomize/helm and applies them to a per-PR namespace —
# the container-backed deploy adapter the native in-Worker REST path can't be (it only
# applies raw, already-rendered manifests). This is a SEPARATE, slimmer image from the
# executor (Pi) image so the k8s CLIs never bloat an agent run's cold-start.
#
# SECURITY: this image carries NO secrets. No cluster credentials, no git credentials.
# Per job, the backend passes a short-lived apiserver bearer token + a git token in the
# POST /jobs body at runtime; they live only for the job in an ephemeral kubeconfig /
# git askpass and are scrubbed from any surfaced output.
#
# Behind a TLS-inspecting (corporate / sandbox) proxy, pass that proxy's CA as a build
# secret so curl/npm trust the upstreams — used only during the build, never persisted:
#   docker build --secret id=extra_ca,src=/path/to/ca.crt -f Dockerfile .

# ---- build: compile the TypeScript wrapper -------------------------------
# Only tsconfig + src are needed to compile. typescript/@types/node are installed
# standalone (the package's dev/test deps incl. pnpm `workspace:*` entries are irrelevant
# here — the runtime uses only Node built-ins + the global k8s CLIs). Pinned by the
# multi-arch index digest (valid for amd64 + arm64 via buildx); the mutable tag is kept
# for readability. To bump: `docker buildx imagetools inspect node:26-trixie-slim`.
FROM node:26-trixie-slim@sha256:a1d9d671994fc2d26e297ac56b4b1522a8bc7fa71c43b14cd1b1fe6c5116f7dc AS build
WORKDIR /app
COPY tsconfig.json ./
RUN --mount=type=secret,id=extra_ca,target=/tmp/extra_ca.crt \
    sh -eu -c 'if [ -s /tmp/extra_ca.crt ]; then export NODE_EXTRA_CA_CERTS=/tmp/extra_ca.crt; fi; \
    npm install --no-save --no-package-lock typescript@^7.0.0 @types/node@^26.0.0'
COPY src ./src
RUN --mount=type=secret,id=extra_ca,target=/tmp/extra_ca.crt \
    sh -eu -c 'if [ -s /tmp/extra_ca.crt ]; then export NODE_EXTRA_CA_CERTS=/tmp/extra_ca.crt; fi; \
    npx tsc -p tsconfig.json'

# ---- runtime: git + the k8s CLIs + the compiled wrapper ------------------
# Pinned to the SAME digest as the build stage above (see that note to bump).
FROM node:26-trixie-slim@sha256:a1d9d671994fc2d26e297ac56b4b1522a8bc7fa71c43b14cd1b1fe6c5116f7dc AS runtime
ENV NODE_ENV=production
# buildx sets TARGETARCH (amd64 | arm64) — the CLI release assets use the same names.
ARG TARGETARCH

# Defense-in-depth: run as an unprivileged user, not root. The kubeconfig + git askpass
# live in an os.tmpdir() mkdtemp dir owned by this user, and a clone goes there too, so
# everything stays writable without root.
RUN groupadd --system harness \
    && useradd --system --gid harness --create-home --home-dir /home/harness harness

# Root-only setup in one layer: git (clone the manifests repo), curl/ca-certificates (to
# fetch the CLIs), then the pinned kubectl / kustomize / helm binaries. All three are
# pinned to exact versions so the image is reproducible and a bad upstream release can't
# silently break a deploy — bump deliberately, and bump the image tag (CONTRIBUTING /
# CLAUDE.md) when you do. git's dubious-ownership guard is disabled system-wide because
# the clone may be owned by another uid in some runtimes.
ARG KUBECTL_VERSION=v1.36.2
ARG KUSTOMIZE_VERSION=v5.8.1
ARG HELM_VERSION=v4.2.2
RUN --mount=type=secret,id=extra_ca,target=/tmp/extra_ca.crt \
    sh -eu -c 'if [ -s /tmp/extra_ca.crt ]; then export CURL_CA_BUNDLE=/tmp/extra_ca.crt; fi; \
    apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl tar && rm -rf /var/lib/apt/lists/*; \
    arch="${TARGETARCH:-amd64}"; \
    curl -fsSL -o /usr/local/bin/kubectl "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${arch}/kubectl"; \
    chmod +x /usr/local/bin/kubectl; \
    curl -fsSL -o /tmp/kustomize.tar.gz "https://github.com/kubernetes-sigs/kustomize/releases/download/kustomize%2F${KUSTOMIZE_VERSION}/kustomize_${KUSTOMIZE_VERSION}_linux_${arch}.tar.gz"; \
    tar -xzf /tmp/kustomize.tar.gz -C /usr/local/bin kustomize; \
    chmod +x /usr/local/bin/kustomize; \
    curl -fsSL -o /tmp/helm.tar.gz "https://get.helm.sh/helm-${HELM_VERSION}-linux-${arch}.tar.gz"; \
    tar -xzf /tmp/helm.tar.gz -C /tmp; \
    mv "/tmp/linux-${arch}/helm" /usr/local/bin/helm; \
    chmod +x /usr/local/bin/helm; \
    rm -rf /tmp/kustomize.tar.gz /tmp/helm.tar.gz /tmp/linux-*; \
    git config --system --add safe.directory "*"; \
    kubectl version --client; kustomize version; helm version'

WORKDIR /app
# Copy the compiled wrapper owned by the unprivileged user, before USER drops privileges.
COPY --chown=harness:harness --from=build /app/dist ./dist
COPY --chown=harness:harness entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh
ENV HOME=/home/harness
USER harness

EXPOSE 8080
ENTRYPOINT ["./entrypoint.sh"]
