# v2 (LangGraph) → v4 (Mastra) Test-Parity Checkpoint

Akshat's review gate: **do not delete the v2 test cases — treat them as the final
checkpoint.** If every v2 behaviour has a passing Mastra equivalent, the migrated
app is behaviourally aligned and good to review.

The v2 tests cannot run as-is (LangGraph node classes vs Mastra workflow steps —
different APIs), so this matrix maps **every v2 `it()` → its Mastra equivalent**.
193 v2 cases across 35 files were audited.

Status legend:
- **COVERED** — Mastra has an equivalent behavioural test.
- **GAP** — behaviour exists in Mastra code but was untested → addressed (see "Gaps closed").
- **N-A** — v2-architecture-only mechanism intentionally removed/relocated in the migration (no analogue).

## Summary

| Area | v2 cases | COVERED | GAP (now closed) | N-A |
|---|---|---|---|---|
| Visualizers (pie/line/bar) | 34 | 34 | 0 | 0 |
| Connectors (pg/rls-pg) | 20 | 20 | 0 | 0 |
| Limit strategies | 20 | 20 | 0 | 0 |
| Dataset controller acceptance | 18 | 18 | 0 | 0 |
| Generation controller/service | 5 | 5 | 0 | 0 |
| db-query nodes (get-tables/columns/sql-gen/cache/fix/validators/save/failed/improve) | ~60 | most | permission + edge-case gaps | ChangeType/OPTIMIZE_CACHED_QUERIES/per-error-trim removed |
| Chat graph + nodes | ~22 | most | date + systemContext + token-map | LangGraph state/DI guards |
| LLM end-to-end acceptance (get-tables/graph) | 6 | 0 | wired via generationAcceptanceBuilder (RUN_WITH_LLM) | — |

## Real regressions found + fixed (behaviour lost, not just untested)

1. **Template table-permission ACL** (`2d6b53d`) — v2 CheckTemplatesNode enforced
   `findMissingPermissions(template.tables)` upfront + persisted authoritative
   tables; Mastra dropped both → possible ACL bypass. Restored upfront skip +
   authoritative dataset tables.
2. **get-tables / check-cache permission filtering** (`7840fae`) — v2
   `_filterByPermissions` and the cache-hit permission re-check were dropped.
   Restored both.
3. **Current-date system-prompt injection** (`4b035f6`) — v2 init-session.node
   injected `Current date is <today>`; Mastra dropped it, breaking relative-time
   queries. Restored via `buildChatInstructions`.

## N-A — v2 mechanisms intentionally removed in the migration

These v2 tests have NO Mastra analogue by design (mechanism replaced):
- **ClassifyChangeNode** (8 tests) — Minor/Major/Rewrite change classification.
  Replaced by `shouldUseCheapForSqlGen` (table-count/attempt-based tier).
- **OPTIMIZE_CACHED_QUERIES env var** tier overrides — removed.
- **fix-query per-error-table schema trimming + syntactic/semantic error-table
  merge** — folded into `classifySqlError` table-expansion (tested).
- **CheckPermissionsNode** (2 tests) — was never wired into the v2 graph (dead
  code); correctly not ported.
- **LangGraph node state guards** (summarise-file/run-tool "throw if no chat ID
  / no last message") — LangGraph state mechanics; Mastra uses thread id +
  agent loop, no analogue.
- **save-dataset throw-on-missing-tenantId/SQL** — Mastra returns an empty
  sentinel instead of throwing (by design); `resolvePersistDeps` null-paths
  tested.

## Gaps closed (behaviour present in Mastra, test added)

| Behaviour | Mastra test |
|---|---|
| Template missing-perm skip + authorized match | db-query-steps.unit.ts checkTemplatesStep |
| resolveTemplateById returns template tables | generate-helpers.unit.ts |
| get-tables filters unauthorized tables + strips schema prefix | db-query-steps.unit.ts getTablesStep |
| check-cache AsIs missing-perms → regenerate | db-query-steps.unit.ts checkCacheStep |
| Current date + systemContext in chat prompt | chat-instructions.unit.ts |
| check-cache out-of-bounds / non-numeric judge index → miss | db-query-steps.unit.ts checkCacheStep |
| buildImproveSqlPrompt embeds validation checklist | generate-helpers.unit.ts |
| buildDatasetReadout AI data-access gate (readAccessForAI off/on, cap, fail-safe) | dataset-readout.unit.ts |
| failedStep generic default-message text | db-query-steps.unit.ts failedStep |

## Re-classified on inspection (were suspected gaps, are N-A by design)

- **sql-gen multiple/historical & baseline-sample feedback blocks** — Mastra
  `buildGenerateSqlPrompt` takes a single `feedback` string (no historical
  block) and a single sample path; the single-feedback rendering is tested.
- **fix-query historical errors / per-error schema trim** — single feedback;
  trim folded into `classifySqlError`.
- **semantic-validator `<available-tables>` injection** — Mastra
  `validateSqlSemantic` does not reselect tables; the judge prompt embeds the
  checklist + request + SQL (verdict parse tested). No table-search analogue.
- **get-columns PK/column trimming** — `pickRelevantTables` returns only the
  table list (`{kind:'tables'}`); all columns flow downstream, so PKs are
  always present. Column-level narrowing was dropped as a prompt-size
  optimisation, not a correctness/permission behaviour.

## LLM end-to-end acceptance — ported (Akshat-approved)

The v2 real-LLM suites (`get-tables-node.acceptance` 4 cases + `db-query.graph.acceptance`
2 cases) were ported into `src/__tests__/acceptance/generation.controllers.acceptance.ts`
as two `RUN_WITH_LLM`-gated describes (6 pending in CI, run manually with a real
model). v2 used `GetTablesNode`/`DbQueryGraph` (removed in Mastra), so:
- End-to-end data cases assert `datasetStore.getData(id)` rows — incl. the
  currency-conversion value check **Charlie White → 9952.61 USD** and
  salary > 8000 → Charlie White, Nameless Gonbei.
- Table-selection cases assert the persisted **dataset.tables CONTAINS** each
  expected table (faithful contains-check; Mastra has no standalone get-tables
  node). 4 prompts: joined-last-month, salary>1000 USD, currencies-without-rates,
  latest-rate-per-currency.

Note: Bizbook (consumer) also runs its own broader real-LLM cases; these are the
**package's own** self-contained parity tests using the repo's seed fixtures.

## Remaining open (minor)

- **end-session per-model token map + thread-metadata persistence** — the
  coalesced total is tested (workflow-runner.unit.ts); the per-model breakdown
  + `updateThread`-metadata persist are not yet asserted.
- **summarise-file** no-file passthrough + multi-file per-pass merge content.
