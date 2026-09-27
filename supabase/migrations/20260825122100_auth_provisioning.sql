-- Phase 1 — Layer 3: Authentication & Session Foundation.
-- Deterministic, idempotent, concurrency-safe Account/AuthIdentity/Profile
-- provisioning, triggered off Supabase Auth's own auth.identities table.
--
-- Why auth.identities, not auth.users: a new provider identity appears here
-- both on first signup (alongside a new auth.users row) and when an
-- existing Account later links an additional provider (no new auth.users
-- row). Triggering on auth.identities covers both with one mechanism,
-- matching 37_Authentication_and_Login.md §7 (an Account may accumulate
-- multiple AuthIdentity records over time).
--
-- Why no proof-of-ownership logic is implemented here: auth.identities is
-- populated exclusively by Supabase Auth's own verified OAuth/email flows —
-- it is not client-writable. By the time a row appears here, Supabase has
-- already verified the provider's proof. This function mirrors an
-- already-verified fact into public.account/public.auth_identity; it does
-- not perform verification itself, and never accepts a client-supplied
-- identity as authoritative.
--
-- SECURITY DEFINER is required: this trigger must write to public.account /
-- public.auth_identity / public.profile regardless of RLS, because it fires
-- as part of Supabase Auth's own internal provisioning step, before any
-- ordinary "authenticated" client request context applies. It performs only
-- the fixed, narrow inserts below — it never accepts or executes
-- client-supplied SQL, and search_path is pinned to prevent hijacking.
create or replace function handle_new_auth_identity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_provider auth_identity_provider;
  v_provider_subject_id text;
  v_email text;
begin
  v_provider := case new.provider
    when 'email' then 'email'::auth_identity_provider
    when 'google' then 'google'::auth_identity_provider
    when 'apple' then 'apple'::auth_identity_provider
    else null
  end;

  -- Defensive: the Supabase project is configured to enable only the three
  -- approved providers, so this should not occur. If it does (e.g. a
  -- provider enabled in error), skip provisioning rather than fail the
  -- underlying Supabase Auth operation or guess at an unapproved method.
  if v_provider is null then
    return new;
  end if;

  -- The OIDC/OAuth "sub" claim is present on every Supabase identity
  -- regardless of internal schema version, and is never the email address —
  -- required so Account/AuthIdentity resolution never trusts email alone
  -- (37_Authentication_and_Login.md §11).
  v_provider_subject_id := new.identity_data ->> 'sub';

  if v_provider_subject_id is null or length(v_provider_subject_id) = 0 then
    -- Cannot safely provision without a stable subject identifier. Skip
    -- rather than fabricate one from email or the internal row id.
    return new;
  end if;

  select email into v_email from auth.users where id = new.user_id;

  -- Idempotent, concurrency-safe Account provisioning. account.id is,
  -- by design, the same value as the Supabase Auth user id (§2) — no
  -- separate mapping table, no email-based matching.
  insert into account (id, email, display_name)
    values (new.user_id, v_email, null)
    on conflict (id) do nothing;

  -- Idempotent, concurrency-safe AuthIdentity provisioning. A repeated or
  -- retried callback for the same (provider, sub) can never create a
  -- duplicate row, via the existing unique constraint.
  insert into auth_identity (account_id, provider, provider_subject_id, linked_at)
    values (new.user_id, v_provider, v_provider_subject_id, now())
    on conflict (provider, provider_subject_id) do nothing;

  -- Auto-create exactly one adult Profile the first time this Account gets
  -- any identity at all, and never a child Profile
  -- (37_Authentication_and_Login.md §6, Master §10). Idempotent: only
  -- fires when the Account currently has zero Profiles, so linking a
  -- second provider to an already-provisioned Account never creates a
  -- second default Profile.
  insert into profile (account_id, display_name, is_child)
    select new.user_id, coalesce(v_email, 'My Profile'), false
    where not exists (select 1 from profile where account_id = new.user_id);

  return new;
end;
$$;

-- Standard, Supabase-documented pattern: a migration-defined trigger on
-- Supabase's own auth schema. This is the supported mechanism for reacting
-- to new/linked identities without a backend service; it requires no
-- change to Supabase's own auth.users/auth.identities tables.
create trigger on_auth_identity_created
  after insert on auth.identities
  for each row execute function handle_new_auth_identity();
