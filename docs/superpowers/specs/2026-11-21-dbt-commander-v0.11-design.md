# DataOps dbt Commander v0.11 — design

## Intent
Look at the data more closely without writing SQL (profile a column), work with preview results (sort, filter,
copy, save as CSV), and add the other common tests from YAML with one click. User picked items 6, 9, 12.

## Goals
6. **Preview results: sort, filter, copy, export**
   - Click a column header to sort (asc → desc → original order); numbers sort as numbers, NULLs last.
   - A filter box above the table keeps rows where any cell contains the text (case-insensitive).
   - **Copy** puts the shown rows (after filter / sort) on the clipboard as tab-separated text with a header row —
     pastes straight into Excel / Sheets.
   - **Save CSV…** writes the shown rows to a file you pick (RFC 4180 quoting, UTF-8, NULL → empty).
   - The meta line says "12 of 100 rows" while a filter is on.
9. **Column profile** — for one column: row count, nulls (count and %), distinct values, min, max and the 10 most
   common values with their counts, in the preview panel. One `dbt show --inline` query, active target.
   Entry points:
   - YAML lightbulb on a model **or source** column: *Profile column `id`*.
   - A small Σ button on each column header of a **model** preview (not scratchpad / CTE / selection previews,
     where the column may not exist in a table).
12. **More test quick fixes** on a model column in YAML (next to v0.10's unique / not_null / accepted_values):
   - *Add relationships test…* — pick the parent model (quick pick of the project's models and sources), then its
     column (its documented / catalog columns, or type a name). Writes `to: ref('customers')` /
     `to: source('raw', 'customers')` and `field:`.
   - When **dbt_utils** is installed (its macros are in the manifest): *Add dbt_utils.not_empty_string*,
     *Add dbt_utils.not_constant*, *Add dbt_utils.at_least_one*, *Add dbt_utils.accepted_range…* (asks for min and/or
     max; numbers only, either may be blank).
   - Arguments go under `arguments:` for dbt ≥ 1.10 (top level for older or unknown versions), as in v0.10.

## Non-goals
Charts / histograms, profiling every column at once, editing data, paging past the preview limit, tests from other
packages (dbt_expectations), editing existing tests.

## Approaches (where there was a real choice)
**Profile query (9).** One query built from dbt's cross-database macros (`dbt.type_string()`,
`dbt.type_bigint()`): stats as `stat | value | count` rows plus the top values, ordered by an internal sort key.
Checked on dbt 1.12 / DuckDB. min / max of types a warehouse can't compare (e.g. Postgres booleans, BigQuery
structs) fail; the error from dbt is shown. (Alternative: one `dbt show` per statistic — 6 slow runs.)

**What gets exported (6).** The rows as shown (filter and sort applied), not the raw result. Only the rows that were
fetched (`dbtCommander.previewLimit`) — the panel says so. (Alternative: re-run without a limit for export —
could pull millions of rows through `dbt show`.)

**Column name in SQL (9).** Plain names as written; anything else through `adapter.quote` (same rule as the staging
model generator), so Snowflake's upper-casing still works for ordinary names.

## Design notes
- `exportrows.ts` (pure): `toCsv(cols, rows)`, `toTsv(cols, rows)`, `sortRows`, `filterRows`.
- `profile.ts` (pure): `profileSql(relation, column)` (relation = `ref(...)` / `source(...)` Jinja), `parseProfile(rows)`.
- `yamlfix.ts`: tests become `{ name, args? }` (args as YAML scalars / flow lists); `sourceColumnAt` for sources.
- Preview panel: rows stay in the extension; the webview sends sort/filter state with Copy / Save so both sides
  use the same pure functions.

## Claude's calls (correct if wrong)
- Copy is tab-separated (pastes into spreadsheets); Save is CSV.
- Profile also on source columns in YAML; Σ only on model previews.
- dbt_utils tests: the four above (column-level, no or simple arguments).
- Commit only; release when asked.
