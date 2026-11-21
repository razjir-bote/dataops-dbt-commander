# DataOps dbt Commander v0.14 — staging model from a bronze source (Synapse template)

## Intent
Right-click a source table → create a staging model in the team's bronze → staging pattern: trim / null-blank /
type every column, rename the key to `entity_id`, keep the latest row per entity and extract date, drop deletes.

## Goals
- **Replaces** the existing **dbt Create staging model…** (user decision): same command, same places — right-click a
  source table in the dbt sidebar or the Lineage panel, or with the cursor on `source('…','…')` — now generating
  this template instead of the plain `select <columns> from source`. The plain template is removed.
- Same flow as the existing command: columns read from the warehouse through dbt (`get_columns_in_relation`), the
  path prompt (`models/staging/<system>/stg_<system>__<entity>.sql` — user decision: `<system>` is the table name
  before its first underscore, `<entity>` everything after it; a table name without one uses the dbt source name
  and the whole table name), a YAML entry with the columns, file opened.
- Generated SQL, exactly in the shape of the example:
  ```sql
  WITH source AS (

      SELECT *
      FROM {{ source('bronze', 'ace_aus_accounttag_account') }}

  ),

  renamed AS (

      SELECT
          NULLIF(LTRIM(RTRIM(CAST([Id] AS NVARCHAR(4000)))), '') AS [entity_id],

          TRY_CAST(NULLIF(LTRIM(RTRIM(TRY_CAST([CreatedOn] AS VARCHAR(4000)))), '') AS DATETIME2) AS [CreatedOn],

          TRY_CAST(NULLIF(LTRIM(RTRIM(TRY_CAST([_bronze_load_date] AS VARCHAR(4000)))), '') AS DATE) AS [_bronze_load_date],
          …
      FROM source

  ),

  deduplicated AS ( … ROW_NUMBER() OVER (PARTITION BY [_landing_extract_date], [entity_id]
                    ORDER BY [_bronze_loaded_at_utc_ts] DESC, [_bronze_run_id] DESC) AS rn … )

  SELECT *
  FROM deduplicated
  WHERE rn = 1
      AND LOWER([IsDelete]) IN ('false', '0')
  ```
  Columns in table order, one blank line between them, `[bracketed]` names (`]` escaped as `]]`).

## Rules (settings, defaults match the example)
| What | Default | Setting |
|---|---|---|
| Columns typed `DATETIME2` | name ends in `On` (`CreatedOn`, `SinkModifiedOn`) or `_ts` / `_at` / `_datetime` | `dbtCommander.bronzeStaging.datetimePattern` (regex) |
| Columns typed `DATE` | name ends in `_date` | `dbtCommander.bronzeStaging.datePattern` |
| Everything else | `NVARCHAR(4000)` trimmed, blank → NULL | — |
| Key column → also `entity_id` | `Id` (case-insensitive) | `dbtCommander.bronzeStaging.keyColumn`, `…keyAlias` |
| Dedupe partition | `_landing_extract_date`, then the key | `…partitionColumns` |
| Dedupe order (newest first) | `_bronze_loaded_at_utc_ts`, `_bronze_run_id` | `…orderColumns` |
| Delete flag | `IsDelete` kept when `'false'` / `'0'` | `…deleteColumn` |

**Key column** (user decision): the key column is **kept under its own name** and `entity_id` is **added** from
it — `entity_id` first in `renamed`, then every column in table order, the key included:
```sql
        NULLIF(LTRIM(RTRIM(CAST([Id] AS NVARCHAR(4000)))), '') AS [entity_id],

        NULLIF(LTRIM(RTRIM(CAST([Id] AS NVARCHAR(4000)))), '') AS [Id],
```

Columns named in the rules but missing from a table are left out of that clause; no delete column → no
`AND LOWER(...)` filter. The generated file is ordinary SQL to edit afterwards.

**No key column** (user decision): dedupe on the data itself, per extract date — partition by
`_landing_extract_date` plus **every column whose name doesn't start with `_`** (columns starting with `_` are load
metadata, which differs between loads of the same rows), newest load first by the same order columns:
```sql
deduplicated AS (

    SELECT
        *,
        ROW_NUMBER() OVER (
            PARTITION BY
                [_landing_extract_date],
                [accountid],
                [versionnumber],
                …every column not starting with _
            ORDER BY
                [_bronze_loaded_at_utc_ts] DESC,
                [_bronze_run_id] DESC
        ) AS rn
    FROM renamed

)
```
So a reload of identical rows collapses to one row per extract date, keeping the newest load's metadata.

## Non-goals
Other adapters' syntax (this template is T-SQL / Synapse; on other warehouses the generated file needs editing),
inferring types from data.

## Claude's calls (correct if wrong)
- **Types come from column names**, not the warehouse type: bronze tables load everything as text, so the example
  types by name (`…On` / `_ts` → DATETIME2, `_date` → DATE). If a column's warehouse type is already a date or
  datetime type and the name doesn't match, it is still typed DATE / DATETIME2.
- Columns the warehouse can't list (table not there yet): `SELECT *` placeholders with a TODO, as today.
- Commit only; release when asked.
