---
'@cat-factory/cli': minor
---

Add the `cat-factory k3s` guided local-cluster setup command (initiative slice 1: host probe +
report).

`cat-factory k3s` probes the machine over a new injectable host shell-out seam (`HostShell`) for a
reachable cluster / installed `k3d`/`kind`/`k3s`/`kubectl` / a running Docker, classifies the host
(pure `classifyHost`), and reports what it found plus a recommended path — reuse the existing
cluster, create a k3d or kind cluster (Docker, no root; selected by `--runtime`), or the guided
(sudo) k3s path (which points at starting an already-installed k3s, or otherwise prints the install
command — never run). The apiserver-contacting `kubectl` probes carry a `--request-timeout` and the
`HostShell` has a watchdog, so a stale kubeconfig fails fast instead of hanging the probe. Mirrors
the `init` command's pure-planner + IO-seam shape and is fully unit-tested with a scripted fake
shell. Cluster provisioning, ServiceAccount/token minting, and wiring the `local-k3s` infra handler
follow in later slices.
