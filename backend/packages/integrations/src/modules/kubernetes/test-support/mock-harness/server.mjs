// A minimal stand-in for the executor-harness HTTP server, just enough to exercise the
// KubernetesRunnerTransport against a REAL apiserver pod-proxy. It speaks the two routes the
// transport uses: `POST /jobs` (accept a dispatch, 202) and `GET /jobs/:id` (return a
// RunnerJobView). It echoes the dispatched body back through the GET so the integration test
// can assert the pod-proxy delivered the payload end-to-end in both directions. NOT the real
// harness — it runs no agent; it only proves the K8s pod lifecycle + pod-proxy plumbing.
import http from 'node:http'

const port = Number(process.env.PORT || 8080)

/** The last dispatch body seen, echoed back on the next poll. */
let lastDispatch = null

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const json = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  // `/health` is what the real executor-harness serves and what the pod's readinessProbe
  // hits; `/healthz` is kept too for any direct caller. Either marks the server up.
  if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/healthz')) {
    res.writeHead(200).end('ok')
    return
  }

  if (req.method === 'POST' && url.pathname === '/jobs') {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      try {
        lastDispatch = body ? JSON.parse(body) : {}
      } catch {
        lastDispatch = { raw: body }
      }
      // A 202 with a running view, like the real harness's async dispatch.
      json(202, { jobId: 'mock-job', state: 'running' })
    })
    return
  }

  if (req.method === 'GET' && url.pathname.startsWith('/jobs/')) {
    const jobId = decodeURIComponent(url.pathname.slice('/jobs/'.length))
    // A terminal RunnerJobView whose `result.custom` carries the dispatched payload, so the
    // test can verify the proxy round-tripped both the POST body and this GET response.
    json(200, { state: 'done', result: { custom: { jobId, dispatched: lastDispatch } } })
    return
  }

  res.writeHead(404).end('not found')
})

server.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`mock-harness listening on ${port}`)
})

// This process is PID 1 in the pod container, and PID 1 gets NO default signal handlers,
// so without this an explicit SIGTERM (what a pod DELETE sends) is ignored and the kubelet
// only stops the container at the end of the termination grace period (SIGKILL). Exiting
// promptly on SIGTERM lets the release→eviction path settle in seconds, not ~30s.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close()
    process.exit(0)
  })
}
