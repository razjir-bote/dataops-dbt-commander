select {{ cents_to_dollars('amount') }} as dollars, {{ dbt.current_timestamp() }} as ts
