---
'@cat-factory/app': patch
---

Confirm a stored personal subscription inline instead of surfacing a validation error.

Saving a personal (individual-usage) subscription in `PersonalSubscriptionSection` empties the
form on success, which recomputed the `disabledReason` guard back to "Enter your token to
continue" and rendered it in red immediately after a successful save — so a completed action
read as a failure. On success the form now shows a transient green "credentials stored securely"
confirmation in that same slot (suppressing `disabledReason` while it's visible), clearing after
a few seconds or as soon as the user begins entering another credential.
