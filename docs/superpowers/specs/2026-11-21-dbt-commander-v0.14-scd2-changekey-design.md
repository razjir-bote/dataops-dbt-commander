# DataOps dbt Commander v0.14 — Create SCD2 change-key model from a staging model

## Intent
Right-click a staging model → create the SCD2 change-key model in the team's template: only extracts not yet in the
history table, with an `attribute_hash` to detect changes. (History model and tests come later, same menu option.)

## Goals
- **dbt Create SCD2 change-key model…** on staging models (`stg_<source>__<entity>.sql`): right-click in the
  Explorer, the dbt sidebar, or the editor.
- Creates `models/intermediate/changekey/int_<source>__<entity>_changekey.sql` (user decision; editable in the
  path prompt) and a YAML entry, then opens it. Same `<source>__<entity>` as the staging model's name.
- SQL exactly in the template's shape, with names filled in:
  - history relation: schema `generate_schema_name('int_history', node)`, identifier
    `dim_<source>__<entity>__history`;
  - `FROM {{ ref('stg_<source>__<entity>') }}`;
  - `loaded_extracts` / `new_extracts` as in the template (`_landing_extract_date` vs `valid_from`);
  - `attribute_hash` (user decisions), the first that applies:
    1. `[versionnumber]` when the staging model has a `versionnumber` column (as in the template);
    2. else `[_full_row_hash]` when it has that column (bronze's own row hash — no hashing at all);
    3. else `{{ hash_columns([...data columns...]) }}` — every column not starting with `_`, except `entity_id`
       and the staging model's `rn` — using the macro below (written only when this case is reached).
- **Macro `hash_columns(columns)`** (user request), written to `macros/hash_columns.sql` in the project the first
  time it's needed (never overwritten; skipped if the project already has a `hash_columns` macro). It returns a
  64-character hex SHA-256 of the columns and **never passes more than 8000 bytes to `HASHBYTES`**, however many or
  wide the columns are:
  1. each column is hashed on its own: `HASHBYTES('SHA2_256', CAST([col] AS NVARCHAR(4000)))` — at most 8000 bytes
     in; NULL becomes 32 zero bytes, so NULL and '' hash differently and no delimiter can be confused with data;
  2. the 32-byte column hashes are concatenated in groups of at most 250 (250 × 32 = 8000 bytes) and each group
     is hashed;
  3. with more than one group, the group hashes are concatenated and hashed once more.
  ```sql
  CONVERT(VARCHAR(64), HASHBYTES('SHA2_256',
      ISNULL(HASHBYTES('SHA2_256', CAST([a] AS NVARCHAR(4000))), CAST(0x00 AS BINARY(32)))
    + ISNULL(HASHBYTES('SHA2_256', CAST([b] AS NVARCHAR(4000))), CAST(0x00 AS BINARY(32)))
    + …), 2)
  ```
  Column order matters (it's part of the hash), and values longer than 4000 characters are hashed on their first
  4000 (staging models already cast every column to NVARCHAR(4000)).
- The staging model's columns come from its YAML entry (Create staging model writes one), else from the warehouse
  through dbt (the model must be built), else a TODO in place of the hash.

## Settings
`dbtCommander.scd2.historySchema` (`int_history`), `…historyPrefix` (`dim_`), `…changeKeyFolder`
(`models/intermediate/changekey`), `…hashColumns` (`["versionnumber", "_full_row_hash"]` — the first one the
staging model has is used as `attribute_hash`), `…extractDateColumn` (`_landing_extract_date`).

## Non-goals (for now)
The history (`dim_…__history`) model and its tests; non-T-SQL syntax.

## Claude's calls (correct if wrong)
- The option shows for model files whose name starts with `stg_`.
- The macro is named `hash_columns` and lives in the project, so other models can use it too. It stays
  per-column (no single-hash fast path): with `versionnumber` / `_full_row_hash` first it's only the last resort.
- It's checked by compiling it with dbt here (DuckDB can't run `HASHBYTES`, so the result is checked as SQL text).
- Commit only; release when asked.
