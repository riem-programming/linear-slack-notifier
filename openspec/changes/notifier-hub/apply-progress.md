# Apply Progress: notifier-hub

## Batch 1 - Slice 1a (Persistence: db + store + migrations)

Mode: Strict TDD. Branch: `feat/1a-persistence-db-store` (base `origin/develop`). Delivery: chained PRs, stacked on `develop`.

### Completed
- [x] 1a.1 RED db tests (open, WAL/foreign_keys, migrate, idempotent, unwritable path)
- [x] 1a.2 RED db tests (pruneEventLog, backup)
- [x] 1a.3 GREEN `src/db.ts`
- [x] 1a.4 RED store tests
- [x] 1a.5 GREEN `src/store.ts`
- [x] 1a.6 REFACTOR: SQL only in `src/db.ts` and `src/store.ts` (verified with ripgrep)

### TDD Cycle Evidence
| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| 1a.1 | `test/db.test.ts` | Unit | N/A (new) | Written (module missing) | 11/11 | 2 unwritable cases, older schema + re-run + rollback | Clean |
| 1a.2 | `test/db.test.ts` | Unit | N/A (new) | Written | 11/11 | age, cap, default cap, 9-day backup rotation, same-day rerun | Clean |
| 1a.3 | `test/db.test.ts` | Unit | N/A (new) | Covered by 1a.1/1a.2 | Passed | n/a | Clean |
| 1a.4 | `test/store.test.ts` | Unit | 78/78 baseline suite | Written (module missing) | 10/10 | both link directions, dup, unlink, FK, null delivery id, limit | Clean |
| 1a.5 | `test/store.test.ts` | Unit | N/A (new) | Covered by 1a.4 | Passed | n/a | Clean |
| 1a.6 | n/a | n/a | n/a | n/a | Full suite 87/87 | n/a | SQL confined to db.ts/store.ts |

### Deviations from design/tasks
- WAL cannot apply to `:memory:` (SQLite reports `memory`), so the WAL assertion uses a temp file; foreign_keys is asserted on `:memory:`.
- `openDb` also runs `migrate` (so a fresh DB is ready on open); `migrate(db, list = migrations)` accepts a list to allow testing older-schema upgrades.
- `insertEvent` returns `false` on duplicate `delivery_id` (ON CONFLICT DO NOTHING) instead of throwing, enabling idempotent webhook handling in 2b.
- Slice is ~514 changed lines (code 232 + tests 282), above the ~400 budget. Natural split boundary: db commit vs store commit.

### Status
6/6 tasks of slice 1a complete. Slices 1b-6 remain.

## Batch 1b - Review fixes on slice 1a (strict TDD, test first)

| Fix | Test | RED | GREEN |
|-----|------|-----|-------|
| `migrate` rejects `user_version` newer than known migrations (`Database schema version N is newer than this build supports (M)`) | `test/db.test.ts` | Failed before change | Passed |
| `backup` does `VACUUM INTO <target>.tmp` then `renameSync`; temp removed on failure; previous same-day snapshot survives (closed-db failure injection); UTC comment added | `test/db.test.ts` | Failed before change (old backup lost) | Passed |

Suite: 89/89 pass, typecheck clean. Delivery: single PR with `size:exception` (user-approved).
