---
'@cat-factory/contracts': minor
'@cat-factory/integrations': minor
'@cat-factory/server': minor
'@cat-factory/app': minor
---

Capability credentials get their operator surface: an Infrastructure-window tab rendering the
checklist of what this deployment's registered tool servers and generative integrations ask for,
joined to what this board has stored.

It is a checklist rather than a blank key-value form because which keys exist is a property of the
deployment's CODE: each row names who wants the value, whether it is required and when it was last
set, so nobody reads the deployment's source to learn what to type. The three things an empty row
can mean stay apart: nothing stored but the environment may still answer, a stored key nothing asks
for any more (removable, and withheld while the declaration read is known to be short), and a
declaration list that could not be read at all. `secrets.manage` hides the tab rather than disabling
it, and so does having nothing to show, since a build registering no capability has no credential to
type.

Also new: `PUT /workspaces/:ws/capability-credentials/:key`, the per-key write the checklist
performs. The whole-set PUT could not serve it: a client that never received the values can neither
re-send the set nor express "leave the others alone", so filling in a second credential through it
would have deleted the first. The whole-set write stays for an API caller declaring a set at once.
