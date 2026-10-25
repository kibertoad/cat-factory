---
'@cat-factory/app': patch
---

The model access policy and run credential policy panels no longer save before the account settings have loaded. A save replaces the whole account config, so a save after a failed load wrote only that panel's key and deleted every other account setting. Both panels now say the settings could not be loaded and disable their save button, the same guard the platform alerts panel already had. The model access policy panel also reports its load failure in a toast instead of ignoring it.
