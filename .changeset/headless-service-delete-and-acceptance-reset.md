---
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/conformance': minor
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
'@cat-factory/gatekeeper-bindings': minor
'@cat-factory/acceptance': minor
---

A headless caller can now DELETE a board service, and the acceptance suite has a command that clears a
board back to "before any pass ran".

The two halves are one change. The acceptance preflight refuses a fresh pass whose target repository
already backs a service frame an earlier pass created, and it offers three ways out: resume the pass
that owns it, point the suite at fresh repositories, or delete the frame. The third was not a command:
deleting a service was an app act, and a public-API key authenticates on `/api/v1` only. So the one
branch an operator running a HEADLESS pass could not act on headlessly was the one that starts over.

**`DELETE /api/v1/services/{serviceId}`** (`admin`, OpenAPI `1.51.0`) closes that, additively. It runs
the same teardown-then-remove sequence the app's own delete does, so a run still going under the frame
is stopped and its container killed before anything is removed. Two answers a caller branches on
rather than retries: a frame holding UNFINISHED tasks is refused with
`422 service_has_unfinished_tasks` (deleting one would discard work in flight along with its history,
so meaning it looks like deleting those tasks first), and an ARCHIVED frame is a `404`, which is the
population rule every per-service endpoint here follows. Archiving stays app-only, deliberately: a
surface that publishes neither the archive nor the restore has no business deleting through one.

**`pnpm --filter @cat-factory/acceptance run reset [runId|latest] [--yes]`** is what uses it. It
targets what the CONFIGURATION would adopt rather than what a ledger remembers, because the gate
refuses over the board as it stands and the hardest case is leftover state whose owning ledger is gone
(another machine, another operator, a state directory somebody cleared). Naming a pass widens the
target to that pass's whole ledger.

Three properties are worth knowing before running it. It PREVIEWS by default and changes nothing
without `--yes`, naming every frame, task and file: the board may be shared. It keeps a pass's local
files whenever any frame that ledger names is still on the board, since the ledger is the only thing
that maps a leftover frame back to a run id, and removing it strands that frame with no pass for the
next refusal to name. And it STATES what no key can reclaim: the two repositories keep whatever a
previous pass scaffolded (with its branches and pull requests), a reporter-filed issue stays open, and
per-PR cluster namespaces are untouched, so a cleared board is not a fresh one.

The suite's configuration now resolves in two halves, and `reset` needs only the BOARD half (the
deployment, the key, the two repositories, the state directory). Requiring a cluster and a reporter
token to clear a board would refuse exactly the operator whose cluster has moved on, which is who is
resetting.
