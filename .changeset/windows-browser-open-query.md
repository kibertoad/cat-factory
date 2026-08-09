---
'@cat-factory/cli': patch
---

Open the full URL in the browser on Windows.

Every link the CLI opens for you carries more than one query parameter, and on Windows all of them
went through `cmd /c start` with the URL unquoted. cmd splits an unquoted command line on `&`, so
the browser received only the parameters before the first one and cmd tried to run each remaining
parameter as a command. `cat-factory k3s` therefore landed on a bare `?infraSetup=local-k3s`: the
Local k3s connect form opened empty, with none of the apiserver URL, namespace template or ingress
host template the deep link exists to prefill. The pre-scoped PAT creation links lost their scopes
the same way.
