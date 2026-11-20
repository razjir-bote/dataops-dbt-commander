{% snapshot snap %}
{{ config(target_schema='main', unique_key='id', strategy='check', check_cols='all') }}
select * from {{ ref('b') }}
{% endsnapshot %}
