-- Phase 2 — Layer 9B: Grocery workflow — USER SHOPPING STATE.
--
-- Additive. The Layer 9A generated artifacts (grocery_list,
-- grocery_list_item, grocery_list_item_source) are NOT modified: their rows
-- stay immutable and carry no user state. The only change to a 9A table is
-- one extra unique key on grocery_list_item (id, grocery_list_id), used as
-- a composite FK target so every state row provably belongs to the item's
-- own generation.
--
-- Every state row belongs to ONE GroceryList generation (never "whatever
-- list is active"). State is never carried to a later generation: a
-- regenerated list starts clean; the old generation keeps its state,
-- read-only.
--
-- grocery_item_already_have         "I already have X" for a generated item
-- grocery_item_shopping_adjustment  "I intend to buy X" (user override of the
--                                   generated-derived target)
-- grocery_manual_item               a user-added shopping line (food or not)
-- grocery_purchase                  a purchase event (quantity), or a
--                                   check-off (no quantity), for a generated
--                                   or manual item
--
-- History: rows are appended; "set" revokes the previous active
-- already-have / adjustment (at most one active each per item); "clear",
-- "remove" and purchase corrections revoke. Nothing is deleted or edited.
-- Writes are allowed only on the CURRENT (active) generation of an active
-- or completed plan. Quantities are stored exactly as the user entered them
-- (quantity + unit); normalization is Layer 5A at read time.

alter table grocery_list_item add constraint uq_grocery_list_item_id_list unique (id, grocery_list_id);

create table grocery_manual_item (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null,
  grocery_list_id uuid not null,
  name text not null check (char_length(name) between 1 and 200),
  quantity numeric check (quantity is null or quantity > 0),
  unit text check (unit is null or char_length(unit) between 1 and 32),
  food_id uuid references food (id),
  notes text check (notes is null or char_length(notes) <= 1000),
  created_at timestamptz not null default now(),
  created_by_account_id uuid references account (id) on delete set null,
  revoked_at timestamptz,
  revoked_by_account_id uuid references account (id) on delete set null,
  constraint uq_grocery_manual_item_id_profile unique (id, profile_id),
  constraint uq_grocery_manual_item_id_list unique (id, grocery_list_id),
  constraint fk_grocery_manual_item_list foreign key (grocery_list_id, profile_id) references grocery_list (id, profile_id) on delete cascade,
  constraint grocery_manual_item_amount check ((quantity is null) = (unit is null)),
  constraint grocery_manual_item_revocation_pair check ((revoked_at is null) = (revoked_by_account_id is null))
);

create index idx_grocery_manual_item_list on grocery_manual_item (grocery_list_id);

create table grocery_item_already_have (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null,
  grocery_list_id uuid not null,
  grocery_list_item_id uuid not null,
  quantity numeric not null check (quantity >= 0),
  unit text not null check (char_length(unit) between 1 and 32),
  note text check (note is null or char_length(note) <= 500),
  created_at timestamptz not null default now(),
  created_by_account_id uuid references account (id) on delete set null,
  revoked_at timestamptz,
  revoked_by_account_id uuid references account (id) on delete set null,
  constraint fk_grocery_already_have_list foreign key (grocery_list_id, profile_id) references grocery_list (id, profile_id) on delete cascade,
  constraint fk_grocery_already_have_item foreign key (grocery_list_item_id, grocery_list_id) references grocery_list_item (id, grocery_list_id) on delete cascade,
  constraint grocery_already_have_revocation_pair check ((revoked_at is null) = (revoked_by_account_id is null))
);

create unique index uq_grocery_already_have_active on grocery_item_already_have (grocery_list_item_id) where revoked_at is null;

create table grocery_item_shopping_adjustment (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null,
  grocery_list_id uuid not null,
  grocery_list_item_id uuid not null,
  quantity numeric not null check (quantity >= 0),
  unit text not null check (char_length(unit) between 1 and 32),
  note text check (note is null or char_length(note) <= 500),
  created_at timestamptz not null default now(),
  created_by_account_id uuid references account (id) on delete set null,
  revoked_at timestamptz,
  revoked_by_account_id uuid references account (id) on delete set null,
  constraint fk_grocery_adjustment_list foreign key (grocery_list_id, profile_id) references grocery_list (id, profile_id) on delete cascade,
  constraint fk_grocery_adjustment_item foreign key (grocery_list_item_id, grocery_list_id) references grocery_list_item (id, grocery_list_id) on delete cascade,
  constraint grocery_adjustment_revocation_pair check ((revoked_at is null) = (revoked_by_account_id is null))
);

create unique index uq_grocery_adjustment_active on grocery_item_shopping_adjustment (grocery_list_item_id) where revoked_at is null;

create table grocery_purchase (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null,
  grocery_list_id uuid not null,
  grocery_list_item_id uuid,
  grocery_manual_item_id uuid,
  -- null quantity = a check-off (for a target with no quantity)
  quantity numeric check (quantity is null or quantity > 0),
  unit text check (unit is null or char_length(unit) between 1 and 32),
  note text check (note is null or char_length(note) <= 500),
  created_at timestamptz not null default now(),
  created_by_account_id uuid references account (id) on delete set null,
  revoked_at timestamptz,
  revoked_by_account_id uuid references account (id) on delete set null,
  constraint fk_grocery_purchase_list foreign key (grocery_list_id, profile_id) references grocery_list (id, profile_id) on delete cascade,
  constraint fk_grocery_purchase_item foreign key (grocery_list_item_id, grocery_list_id) references grocery_list_item (id, grocery_list_id) on delete cascade,
  constraint fk_grocery_purchase_manual foreign key (grocery_manual_item_id, grocery_list_id) references grocery_manual_item (id, grocery_list_id) on delete cascade,
  constraint grocery_purchase_one_target check ((grocery_list_item_id is null) <> (grocery_manual_item_id is null)),
  constraint grocery_purchase_amount check ((quantity is null) = (unit is null)),
  constraint grocery_purchase_revocation_pair check ((revoked_at is null) = (revoked_by_account_id is null))
);

create index idx_grocery_purchase_list on grocery_purchase (grocery_list_id);

-- ------------------------------------------------------------------
-- Shopping state is writable only by a write scope, on the CURRENT
-- generation of an active or completed plan.
-- ------------------------------------------------------------------
create or replace function grocery_shopping_writable(p_grocery_list_id uuid, p_profile_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_list_status grocery_list_status;
  v_plan_status meal_plan_status;
begin
  if profile_access_scope(p_profile_id) is null
     or profile_access_scope(p_profile_id) not in ('full_management', 'pediatric_weight_management') then
    raise exception 'not permitted to change shopping state for this profile' using errcode = '42501';
  end if;
  select l.status, p.status into v_list_status, v_plan_status
    from grocery_list l join meal_plan p on p.id = l.meal_plan_id
   where l.id = p_grocery_list_id and l.profile_id = p_profile_id;
  if v_list_status is null then
    raise exception 'grocery list not found' using errcode = 'P0002';
  end if;
  if v_list_status <> 'active' or v_plan_status not in ('active', 'completed') then
    raise exception 'shopping state can only change on the current generation of an active or completed plan'
      using errcode = '23514', constraint = 'grocery_shopping_list_writable';
  end if;
end;
$$;

revoke all on function grocery_shopping_writable(uuid, uuid) from public;

create or replace function grocery_shopping_state_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.created_at := now();
  new.created_by_account_id := auth.uid();
  new.revoked_at := null;
  new.revoked_by_account_id := null;
  perform grocery_shopping_writable(new.grocery_list_id, new.profile_id);

  if tg_table_name in ('grocery_item_already_have', 'grocery_item_shopping_adjustment') then
    -- "set" replaces: the previous active value is revoked, not edited
    perform pg_advisory_xact_lock(hashtextextended(tg_table_name || ':' || new.grocery_list_item_id::text, 0));
    execute format('update %I set revoked_at = now(), revoked_by_account_id = auth.uid() where grocery_list_item_id = $1 and grocery_list_id = $2 and profile_id = $3 and revoked_at is null', tg_table_name)
      using new.grocery_list_item_id, new.grocery_list_id, new.profile_id;
  elsif tg_table_name = 'grocery_purchase' then
    -- (a separate IF: the column exists only on grocery_purchase)
    if new.grocery_manual_item_id is not null then
      if exists (select 1 from grocery_manual_item m where m.id = new.grocery_manual_item_id and m.revoked_at is not null) then
        raise exception 'a removed manual item cannot be purchased' using errcode = '23514', constraint = 'grocery_purchase_manual_item_active';
      end if;
    end if;
  end if;
  return new;
end;
$$;

revoke all on function grocery_shopping_state_insert() from public;

-- Revocation (once) is the only permitted change.
create or replace function grocery_shopping_state_revoke_only()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.revoked_at is not null then
    raise exception '%: a revoked record is immutable', tg_table_name using errcode = '55000';
  end if;
  if new.revoked_at is null then
    raise exception '%: the only permitted change is revocation', tg_table_name using errcode = '55000';
  end if;
  new.revoked_at := now();
  new.revoked_by_account_id := auth.uid();
  if (to_jsonb(new) - 'revoked_at' - 'revoked_by_account_id') is distinct from (to_jsonb(old) - 'revoked_at' - 'revoked_by_account_id') then
    raise exception '%: the only permitted change is revocation', tg_table_name using errcode = '55000';
  end if;
  perform grocery_shopping_writable(old.grocery_list_id, old.profile_id);
  return new;
end;
$$;

revoke all on function grocery_shopping_state_revoke_only() from public;

create trigger trg_grocery_manual_item_insert before insert on grocery_manual_item
  for each row execute function grocery_shopping_state_insert();
create trigger trg_grocery_already_have_insert before insert on grocery_item_already_have
  for each row execute function grocery_shopping_state_insert();
create trigger trg_grocery_adjustment_insert before insert on grocery_item_shopping_adjustment
  for each row execute function grocery_shopping_state_insert();
create trigger trg_grocery_purchase_insert before insert on grocery_purchase
  for each row execute function grocery_shopping_state_insert();

create trigger trg_grocery_manual_item_revoke_only before update on grocery_manual_item
  for each row execute function grocery_shopping_state_revoke_only();
create trigger trg_grocery_already_have_revoke_only before update on grocery_item_already_have
  for each row execute function grocery_shopping_state_revoke_only();
create trigger trg_grocery_adjustment_revoke_only before update on grocery_item_shopping_adjustment
  for each row execute function grocery_shopping_state_revoke_only();
create trigger trg_grocery_purchase_revoke_only before update on grocery_purchase
  for each row execute function grocery_shopping_state_revoke_only();

-- ------------------------------------------------------------------
-- RLS — the grocery scopes (never broadened):
-- read: full_management, view_only, pediatric_weight_management;
-- write (insert, revoke): full_management, pediatric_weight_management.
-- No DELETE grants.
-- ------------------------------------------------------------------
alter table grocery_manual_item enable row level security;
alter table grocery_item_already_have enable row level security;
alter table grocery_item_shopping_adjustment enable row level security;
alter table grocery_purchase enable row level security;

grant select, insert, update on grocery_manual_item to authenticated;
grant select, insert, update on grocery_item_already_have to authenticated;
grant select, insert, update on grocery_item_shopping_adjustment to authenticated;
grant select, insert, update on grocery_purchase to authenticated;

create policy grocery_manual_item_select_authorized on grocery_manual_item for select to authenticated
  using (profile_access_scope(profile_id) in ('full_management', 'view_only', 'pediatric_weight_management'));
create policy grocery_manual_item_insert_managed on grocery_manual_item for insert to authenticated
  with check (profile_access_scope(profile_id) in ('full_management', 'pediatric_weight_management'));
create policy grocery_manual_item_update_managed on grocery_manual_item for update to authenticated
  using (profile_access_scope(profile_id) in ('full_management', 'pediatric_weight_management'))
  with check (profile_access_scope(profile_id) in ('full_management', 'pediatric_weight_management'));

create policy grocery_already_have_select_authorized on grocery_item_already_have for select to authenticated
  using (profile_access_scope(profile_id) in ('full_management', 'view_only', 'pediatric_weight_management'));
create policy grocery_already_have_insert_managed on grocery_item_already_have for insert to authenticated
  with check (profile_access_scope(profile_id) in ('full_management', 'pediatric_weight_management'));
create policy grocery_already_have_update_managed on grocery_item_already_have for update to authenticated
  using (profile_access_scope(profile_id) in ('full_management', 'pediatric_weight_management'))
  with check (profile_access_scope(profile_id) in ('full_management', 'pediatric_weight_management'));

create policy grocery_adjustment_select_authorized on grocery_item_shopping_adjustment for select to authenticated
  using (profile_access_scope(profile_id) in ('full_management', 'view_only', 'pediatric_weight_management'));
create policy grocery_adjustment_insert_managed on grocery_item_shopping_adjustment for insert to authenticated
  with check (profile_access_scope(profile_id) in ('full_management', 'pediatric_weight_management'));
create policy grocery_adjustment_update_managed on grocery_item_shopping_adjustment for update to authenticated
  using (profile_access_scope(profile_id) in ('full_management', 'pediatric_weight_management'))
  with check (profile_access_scope(profile_id) in ('full_management', 'pediatric_weight_management'));

create policy grocery_purchase_select_authorized on grocery_purchase for select to authenticated
  using (profile_access_scope(profile_id) in ('full_management', 'view_only', 'pediatric_weight_management'));
create policy grocery_purchase_insert_managed on grocery_purchase for insert to authenticated
  with check (profile_access_scope(profile_id) in ('full_management', 'pediatric_weight_management'));
create policy grocery_purchase_update_managed on grocery_purchase for update to authenticated
  using (profile_access_scope(profile_id) in ('full_management', 'pediatric_weight_management'))
  with check (profile_access_scope(profile_id) in ('full_management', 'pediatric_weight_management'));
