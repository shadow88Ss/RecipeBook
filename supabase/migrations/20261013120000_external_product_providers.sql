-- Layer 11D — external product-data providers (FatSecret, Open Food Facts).
--
-- Additive to 20261012120000 (Layer 11C); nothing there is edited.
--
-- 1. Closes the 11C exposure: enabled_provider_routes() (SECURITY DEFINER,
--    callable by any authenticated user for runtime routing) no longer
--    returns secret_reference. It returns only what selecting and invoking
--    an adapter needs: key, priority, environment, non-secret configuration
--    and whether a credential is attached. The adapter itself declares where
--    its credential lives (API code), and the admin API refuses a
--    secret_reference that differs from that declaration.
-- 2. Stops advertising capabilities the Layer 11D adapters do not implement:
--    FatSecret food_search (only product_search is implemented) and Open
--    Food Facts product_search (its 10 searches/min/IP limit is not safe for
--    consumer search traffic). The rows stay (registry rows are never
--    deleted) but are disabled.
--
-- No table, Product, Barcode or label row is written from provider data:
-- external results are candidates held in API memory only.

drop function enabled_provider_routes(provider_family, text);

create function enabled_provider_routes(p_family provider_family, p_capability text)
returns table (provider_key text, priority int, environment provider_environment, configuration jsonb, credential_attached boolean)
language sql
stable
security definer
set search_path = public
as $$
  select p.provider_key, c.priority, p.environment, p.configuration, p.secret_reference is not null
    from external_provider p
    join external_provider_capability c on c.provider_id = p.id
   where p.enabled and c.enabled and p.provider_family = p_family and c.provider_family = p_family and c.capability = p_capability
   order by c.priority, p.provider_key;
$$;

comment on function enabled_provider_routes(provider_family, text) is
  'Layer 11D: runtime routing for ordinary server flows. Never returns secret references, secret values, health or audit data.';

revoke all on function enabled_provider_routes(provider_family, text) from public;
grant execute on function enabled_provider_routes(provider_family, text) to authenticated;

update external_provider_capability c
   set enabled = false
  from external_provider p
 where p.id = c.provider_id
   and ((p.provider_key = 'fatsecret' and c.capability = 'food_search')
     or (p.provider_key = 'open_food_facts' and c.capability = 'product_search'));
