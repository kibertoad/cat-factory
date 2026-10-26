---
'@cat-factory/app': patch
---

The account settings panels on the Team tab (model access policy, run credential policy, platform alerts, content storage) no longer save over an account config they do not have. A save replaces the whole account config, so a save after a failed load deleted every other account setting, and a save after the active account changed copied the previous account's settings over. The account settings store now records which account its view belongs to, clears the view when a load fails, sends one request for overlapping loads, and merges each panel's change through one `saveConfigPatch` that refuses when the view is not that account's. The model access policy and run credential policy panels hide their editor and show a notice while the settings are not loaded.
