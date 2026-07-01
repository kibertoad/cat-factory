---
---

docs(initiatives): resolve the local k3s guided-setup surface decision (hybrid, CLI-primary) and
concretize the slices. The `cat-factory k3s` CLI owns privileged host provisioning (probe →
k3d/k3s cluster → least-privilege SA token); the SPA `Local k3s` hint gains a deep-linked
auto-setup entry point that pre-fills the existing engine form for the #557 Test → Save. No code
change yet — this updates `docs/initiatives/local-k3s-guided-setup.md` (the plan of record).
