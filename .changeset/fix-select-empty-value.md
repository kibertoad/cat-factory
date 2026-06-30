---
'@cat-factory/app': patch
---

Fix console error spam (and broken `<USelect>` rendering) in the Infrastructure settings window. The kubernetes scheme pickers (`KubernetesEngineForm`, `KubernetesEnvironmentForm`) and the sandbox judge-model picker used an empty-string option value as the "default" sentinel, which reka-ui's `SelectItem` forbids (it reserves `''` to clear the selection). Switch the sentinel to a non-empty `'default'` value; the request payload still omits the field for that value, so the wire shape is unchanged.
