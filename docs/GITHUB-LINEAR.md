# GitHub and Linear workflow

Pull requests update Linear issues through Linear's native GitHub integration. This service has no code for it and does not depend on it.

## Quick path

1. In Linear, open the issue and copy the branch name (Ctrl/Cmd+Shift+.). It contains the issue ID, for example `kamaiti-83-...`.
2. Create the branch, push, open the PR.
3. Put `Fixes KAMAITI-83` in the PR description.
4. Merge. The issue moves to Done and the notifier posts it.

## Linking a PR to an issue

Any one of these links the PR. Using two is fine.

| Method | Example |
|--------|---------|
| Branch name with the issue ID | `kamaiti-83-fix-estado-help` (use Linear's copy shortcut) |
| Issue ID in the PR title | `fix(bot): square brackets in help (KAMAITI-83)` |
| Magic word in the PR description | `Fixes KAMAITI-83` |

### Magic words

| Type | Words | Effect on merge |
|------|-------|-----------------|
| Closing | `Fixes`, `Closes`, `Resolves`, `Completes` | Issue moves to Done |
| Non-closing | `Ref`, `Part of`, `Related to` | Issue is linked only |

Several issues in one PR: repeat the word or list the IDs, for example `Fixes KAMAITI-83, KAMAITI-84` or `Part of KAMAITI-90`.

## Automation for team KAMAI TI

| GitHub event | Linear status |
|--------------|---------------|
| PR draft or open | In Progress |
| PR in review | In Review |
| PR merged | Done |
| Branch rule `main` | No action |

Merging into `main` does not change any status. The status changes when the feature PR merges into its target branch (normally `develop`).

## Recommended convention

- Create the branch from Linear (it carries the ID).
- Add `Fixes KAMAITI-XX` to the PR body.
- Use `Part of KAMAITI-XX` on PRs that are only a slice of an issue, and close it with the last one.

## Stacked PRs

When PRs are chained (each based on the previous branch):

- After merging the previous PR, retarget the next PR's base to `develop`.
- Use **merge commits**, not squash. Squashing rewrites the commits the next branch is built on and produces conflicts.

## Notes

- Tasks with no code (research, config, meetings) are closed manually in Linear.
- Changing the GitHub connection in Linear does not affect this service. New repositories must be granted to the integration before PRs there are linked.
- When a PR moves an issue to Done, Linear sends the webhook and the notifier posts `{actor} completó KAMAITI-XX`. This requires the issue to belong to a project linked to a channel (see [OPERATIONS.md](OPERATIONS.md#admin-panel)).
