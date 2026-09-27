-- Phase 1 — Layer 2: Row Level Security — Helper Functions
--
-- These are SECURITY DEFINER functions. They are necessary because a policy
-- on `profile` or `guardian_authorization` cannot itself query those same
-- (RLS-protected) tables without recursing into RLS evaluation again. A
-- SECURITY DEFINER function runs with the privileges of its owner (bypassing
-- RLS on the tables it reads internally) while still deriving every decision
-- solely from auth.uid() — the server-verified Supabase Auth identity for
-- the current request. No client-supplied identity is ever trusted; the
-- function accepts only a target id to check, never an actor id.
--
-- search_path is pinned explicitly on every SECURITY DEFINER function to
-- prevent search-path hijacking (a well-known SECURITY DEFINER attack: an
-- attacker-controlled schema earlier in an unpinned search_path could shadow
-- a table/function reference inside the function body).
--
-- EXECUTE is revoked from PUBLIC and re-granted only to `authenticated`ho
-- these are not meant to be callable by anonymous/unauthenticated requests.

-- current_account_id(): thin, readable wrapper over auth.uid(). Account.id is
-- defined (37_Authentication_and_Login.md, 29_Data_Model.md) to equal the
-- corresponding Supabase Auth auth.users.id, so no lookup/mapping table is
-- required — auth.uid() *is* the Account id. This wrapper exists only so
-- policies read as domain language and so the single point of truth for
-- "who is the caller" is one function, not auth.uid() sprinkled everywhere.
create or replace function current_account_id()
returns uuid
language sql
stable
as $$
  select auth.uid();
$$;

revoke all on function current_account_id() from public;
grant execute on function current_account_id() to authenticated;

-- profile_access_scope(target_profile_id): the single source of truth for
-- "what access, if any, does the caller have to this Profile."
--
-- For an ADULT profile (is_child = false): access is direct ownership only
-- (profile.account_id = auth.uid()), per 33_Security_and_Privacy.md §2.1.
-- Adult profiles have no guardian model in Phase 1.
--
-- For a CHILD profile (is_child = true): access flows *exclusively* through
-- an active GuardianAuthorization row — never through profile.account_id,
-- per 33_Security_and_Privacy.md §2.2 ("an Account may access a child
-- Profile if and only if it holds an active GuardianAuthorization row").
-- profile.account_id on a child profile records who *created* it, which is
-- used only once, by the guardian_authorization INSERT policy, to bootstrap
-- that creator's own first grant — never as an ongoing access grant. If a
-- child profile's creator is later revoked, this function correctly returns
-- NULL for them, matching "a revoked GuardianAuthorization MUST NOT grant
-- access."
--
-- Returns the actual authorization_scope value for a child profile (one of
-- full_management / view_only / pediatric_weight_management), or the literal
-- 'full_management' scope value for an owned adult profile (since an owner
-- of their own adult profile has unrestricted access to it), or NULL if the
-- caller has no access at all.
--
-- Individual table policies decide what each scope value actually permits —
-- this function only resolves *which* scope applies, it does not itself
-- grant anything. In particular, no policy in this Layer 2 implementation
-- currently checks for `= 'pediatric_weight_management'` anywhere (see the
-- RLS Security Report's flagged specification gap) — a guardian whose only
-- authorization is that scope value receives no additional access under any
-- policy in this migration set, by deliberate omission, not oversight.
create or replace function profile_access_scope(target_profile_id uuid)
returns guardian_authorization_scope
language sql
stable
security definer
set search_path = public
as $$
  select
    case
      when p.is_child then ga.authorization_scope
      when p.account_id = auth.uid() then 'full_management'::guardian_authorization_scope
      else null
    end
  from profile p
  left join guardian_authorization ga
    on ga.child_profile_id = p.id
   and ga.guardian_account_id = auth.uid()
   and ga.revoked_at is null
  where p.id = target_profile_id;
$$;

revoke all on function profile_access_scope(uuid) from public;
grant execute on function profile_access_scope(uuid) to authenticated;

-- can_read_recipe(target_recipe_id): true if the caller may read this Recipe
-- — either it is shared_library (readable by any authenticated caller), or
-- it was authored under a Profile the caller has any access scope to, or
-- (for a recipe with no profile attribution) the caller is its creating
-- Account. Used by Recipe, RecipeVersion, RecipeIngredient, RecipeInstruction.
create or replace function can_read_recipe(target_recipe_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from recipe r
    where r.id = target_recipe_id
      and (
        r.visibility = 'shared_library'
        or (r.created_by_profile_id is not null and profile_access_scope(r.created_by_profile_id) is not null)
        or (r.created_by_profile_id is null and r.created_by_account_id = auth.uid())
      )
  );
$$;

revoke all on function can_read_recipe(uuid) from public;
grant execute on function can_read_recipe(uuid) to authenticated;

-- can_manage_recipe(target_recipe_id): true if the caller may write to this
-- Recipe or create a new RecipeVersion/RecipeIngredient/RecipeInstruction
-- under it — ownership only (view_only guardians may read but not manage).
create or replace function can_manage_recipe(target_recipe_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from recipe r
    where r.id = target_recipe_id
      and (
        (r.created_by_profile_id is not null and profile_access_scope(r.created_by_profile_id) = 'full_management')
        or (r.created_by_profile_id is null and r.created_by_account_id = auth.uid())
      )
  );
$$;

revoke all on function can_manage_recipe(uuid) from public;
grant execute on function can_manage_recipe(uuid) to authenticated;

-- is_child_profile_created_by_caller(target_profile_id): true if the target
-- Profile is a child profile whose profile.account_id is the caller. Used
-- ONLY by the guardian_authorization bootstrap INSERT policy, to answer "did
-- I create this child profile" — the single legitimate use of
-- profile.account_id as a trust anchor for a child profile (see
-- profile_access_scope's comment above).
--
-- This must be SECURITY DEFINER, not an ordinary subquery: at the moment a
-- guardian is bootstrapping their very first grant, no guardian_authorization
-- row yet exists, so profile_access_scope(target_profile_id) is NULL and
-- profile's own SELECT policy (profile_select_authorized) correctly hides
-- the row from an ordinary, non-definer query — even from its own creator.
-- That is the intended, spec-correct behavior (33_Security_and_Privacy.md
-- §2.2: nobody has access without an active grant, no exception for the
-- creator). An earlier version of the bootstrap policy used a plain
-- subquery here, which was itself silently blocked by that same profile RLS
-- policy — a recursive-RLS bug, not a security weakening, found and fixed
-- during Layer 2 verification testing (see the RLS Security Report).
create or replace function is_child_profile_created_by_caller(target_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from profile p
    where p.id = target_profile_id
      and p.is_child
      and p.account_id = auth.uid()
  );
$$;

revoke all on function is_child_profile_created_by_caller(uuid) from public;
grant execute on function is_child_profile_created_by_caller(uuid) to authenticated;
