-- Option A hardening (migration 48): private provider settings leave the database.
--
-- Additive to 20261012120000 (Layer 11C) and 20261013120000 (Layer 11D);
-- nothing there is edited.
--
-- Finding: enabled_provider_routes() is SECURITY DEFINER and executable by
-- every signed-in user, because the API routes provider calls with the
-- caller's own token. It returned each enabled provider's full stored
-- configuration, including the Open Food Facts User-Agent contact
-- (contact_email), plus credential_attached (secret-reference metadata).
--
-- Correction (no new role, credential or authentication mechanism):
--   1. Stored configuration loses contact_email. The API now resolves it from
--      its own environment (OPEN_FOOD_FACTS_CONTACT_EMAIL), declared by the
--      adapter as a private setting. Deploy that API before this migration.
--   2. A check constraint keeps private settings out of stored configuration
--      for good: no contact-like key (e-mail, contact, phone) and no
--      e-mail-like string value at any depth. The admin API refuses the same
--      shapes first (reason private_setting_in_configuration).
--   3. enabled_provider_routes() returns only routing data and non-sensitive
--      operational configuration: provider_key, priority, environment,
--      configuration. credential_attached is gone; the API derives it from
--      the adapter's declaration.
--
-- Admin tables, RLS policies, admin functions and audit triggers are
-- unchanged. The configuration update below is audited by the existing
-- trigger as external_provider_configuration_changed (field names only,
-- never values).

-- 1. Remove the stored private value (not copied anywhere).
update external_provider
   set configuration = configuration - 'contact_email'
 where configuration ? 'contact_email';

-- 2. Private settings can never be stored again.
alter table external_provider
  add constraint external_provider_configuration_not_private check (
    not jsonb_path_exists(configuration, 'lax $.** ? (@.type() == "object").keyvalue() ? (@.key like_regex "e-?mail|contact|phone" flag "i")')
    and not jsonb_path_exists(configuration, 'lax $.** ? (@.type() == "string" && @ like_regex "[^@ ]+@[^@ ]+[.][^@ ]+")')
  );

-- 3. Routing returns routing data and operational configuration only.
drop function enabled_provider_routes(provider_family, text);

create function enabled_provider_routes(p_family provider_family, p_capability text)
returns table (provider_key text, priority int, environment provider_environment, configuration jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select p.provider_key, c.priority, p.environment, p.configuration
    from external_provider p
    join external_provider_capability c on c.provider_id = p.id
   where p.enabled and c.enabled and p.provider_family = p_family and c.provider_family = p_family and c.capability = p_capability
   order by c.priority, p.provider_key;
$$;

comment on function enabled_provider_routes(provider_family, text) is
  'Migration 48: runtime routing for ordinary server flows. Returns provider key, priority, environment and non-sensitive operational configuration only. Never returns secret references or their presence, private settings, health or audit data.';

revoke all on function enabled_provider_routes(provider_family, text) from public;
revoke all on function enabled_provider_routes(provider_family, text) from anon;
grant execute on function enabled_provider_routes(provider_family, text) to authenticated;
