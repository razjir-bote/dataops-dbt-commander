# DataOps dbt Commander v0.15 — Add a seed as a source

## Intent
Use a seed (e.g. sample bronze data) the way the real data will be used: as a `source()`, so *Create staging
model* and `{{ source('…', '…') }}` work against it before the real table exists.

## Goals
- **dbt Add seed as source…** — right-click a seed `.csv` in the Explorer or the dbt sidebar (several at once
  work: one source table each).
- Asks for the **source name** (default: `bronze`; remembered for next time) and writes a `sources:` entry whose
  table points at the seed's built table:
  ```yaml
  version: 2
  sources:
    - name: bronze
      schema: main            # the seed's schema (from the manifest, i.e. after +schema / generate_schema_name)
      database: demo           # only when the seed's database differs from the target's
      tables:
        - name: ace_aus_accounttag_account
          description: "Loaded from the seed ace_aus_accounttag_account (dbt seed)."
          columns:
            - name: Id
            - name: SinkCreatedOn
            …
  ```
  Columns come from the CSV header. If a source with that name already exists in the file, the table is added
  under it (same schema); an existing table of that name is left alone (reported).
- File: `<model-path>/staging/<source>/_<source>__sources.yml` (e.g. `models/staging/bronze/_bronze__sources.yml`),
  created if missing; shown in a path prompt you can change.
- Afterwards the source table appears in the sidebar after the next parse (`dbt parse` is run), ready for
  *Create staging model*.

## Non-goals
Freshness / loaded_at settings, changing the seed's own config, removing sources.

## Claude's calls (correct if wrong)
- The seed must have been parsed (manifest) to know its schema; if it isn't in the manifest yet, `dbt parse` runs
  first. The table must exist (run *dbt seed*) before the source can be queried — offered as a button.
- Default source name `bronze` (matching your sample's staging template); the file layout above follows the
  dbt convention `_<source>__sources.yml`.
- Commit only; release when asked.
