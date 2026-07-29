---
'@cat-factory/executor-harness': minor
'@cat-factory/local-server': patch
---

Respect the target repository's own pull-request template: a PR-opening coding dispatch now finds
it and the agent fills it in, instead of the platform's free-form briefing.

Neither GitHub nor GitLab applies a template to an API-created pull request — that only happens for
a human opening one in the web form — so the platform's pull requests were the only ones on a repo
silently missing the structure its reviewers expect, with nothing failing or warning to say so.

The harness discovers the template from the checkout it already has (`.github/PULL_REQUEST_TEMPLATE.md`
and GitHub's root/`docs/` and multi-template-directory variants, plus GitLab's
`.gitlab/merge_request_templates/`; case-insensitive, both hosts' conventions probed whatever the
repo's provider) and folds it into the prompt of the agent that just did the work, which writes its
`.cat-pr-description.md` as the filled template. Where the template asks for something the platform's
briefing guidance does not, the template wins. Repos shipping no template are byte-for-byte
unaffected.

A directory holding SEVERAL templates with no `default` is deliberately left alone: that directory
exists so a human can choose per pull request, and picking one arbitrarily would file every run's
work under whichever name sorts first while looking deliberate.

Bumps the runner image to `1.77.0` (harness `src/**` changed).
