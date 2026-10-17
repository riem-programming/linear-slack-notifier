# Apply Progress: admin-ux-refresh

Mode: Strict TDD. Delivery: chained stacked PRs onto develop. Linear: KAMAITI-93.

## Batch 1: Slice 1a (branch `feat/kamaiti-93-admin-assets-csp`)

Completed: 1a.1, 1a.2, 1a.3, 1a.4, 1a.5, 1a.6. Remaining: slices 1b through 5b.

### TDD Cycle Evidence
| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| 1a.1 | `test/assets.test.ts` | Unit (bare http server) | N/A (new) | Written, failed (module missing) | 273/273 | 4 behaviors: version match, mismatch, 404 names, URL hash | None needed |
| 1a.2 | `test/config.test.ts` | Unit | 4/4 | Written, 2 failed | 6/6 | trim, cut at 40, blank, empty, unset | None needed |
| 1a.3 | `test/admin.test.ts` | App (ephemeral port) | 42/42 | Written, 2 failed | 44/44 | CSP on 200 and 401, assets with/without auth, disabled admin, bad names | None needed |
| 1a.4 | `test/assets.test.ts`, `test/admin.test.ts` | covered above | | | | | |
| 1a.5 | `test/config.test.ts`, `test/admin.test.ts` | covered above | | | | | |
| 1a.6 | full suite | | | | `pnpm test` 277/277, `pnpm typecheck` clean | | CSP built from a directive list |

### Notes
- Assets route sits after the "admin disabled" check and before Basic Auth, so a disabled admin answers 403 for assets too (matches the final spec).
- `adminEnvLabel` is loaded but not consumed until slice 1b.
- Dockerfile `COPY src ./src` already ships `src/public`; `.dockerignore` does not exclude it.
- Existing pages still use inline styles; they render unstyled under the new CSP until slice 1b.
