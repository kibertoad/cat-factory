# Tiny mock executor-harness used ONLY by the Kubernetes runner integration test
# (KubernetesRunnerTransport.it.spec.ts). It serves the minimal `/jobs` HTTP contract the
# transport drives through the apiserver pod-proxy. Built locally and `k3d image import`ed
# into the test cluster; never published. See server.mjs for the routes.
FROM node:22-alpine
WORKDIR /app
COPY server.mjs ./
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.mjs"]
