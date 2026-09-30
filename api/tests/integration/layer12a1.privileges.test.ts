// Layer 12A.1 — the database privilege model, pinned. The harness builds the
// chain under a hosted Supabase project's default privileges
// (tests/fixtures/supabase-default-privileges.sql), so these assertions hold
// only because 20261014120000_align_supabase_default_privileges removes the
// automatic grants. The same numbers are the DEV/live checks in
// docs/40_Development_Environment.md §2.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { rebuildTestDatabase } from '../helpers/testDb';

const ALIGNMENT = '20261014120000_align_supabase_default_privileges.sql';

// Every direct table privilege of `authenticated` (117). `anon` has none.
const AUTHENTICATED_TABLE_PRIVILEGES: Record<string, string> = {
  account: 'SELECT,INSERT,UPDATE',
  activity: 'SELECT,INSERT',
  ai_extraction: 'SELECT',
  auth_identity: 'SELECT,INSERT,UPDATE',
  barcode: 'SELECT',
  child_profile_extension: 'SELECT,INSERT,UPDATE',
  clinician_target: 'SELECT,INSERT',
  device_session: 'SELECT,INSERT,UPDATE',
  effective_target_snapshot: 'SELECT,INSERT',
  external_provider: 'SELECT,INSERT,UPDATE',
  external_provider_capability: 'SELECT,INSERT,UPDATE',
  food: 'SELECT',
  food_alias: 'SELECT',
  food_nutrient: 'SELECT',
  food_serving: 'SELECT',
  goal: 'SELECT,INSERT,UPDATE,DELETE',
  grocery_item_already_have: 'SELECT,INSERT,UPDATE',
  grocery_item_shopping_adjustment: 'SELECT,INSERT,UPDATE',
  grocery_list: 'SELECT,INSERT',
  grocery_list_item: 'SELECT,INSERT',
  grocery_list_item_source: 'SELECT,INSERT',
  grocery_manual_item: 'SELECT,INSERT,UPDATE',
  grocery_purchase: 'SELECT,INSERT,UPDATE',
  guardian_authorization: 'SELECT,INSERT,UPDATE',
  import_job: 'SELECT,INSERT',
  meal_item: 'SELECT,INSERT,UPDATE',
  meal_log: 'SELECT,INSERT,UPDATE',
  meal_plan: 'SELECT,INSERT,UPDATE',
  meal_plan_day: 'SELECT,INSERT',
  nutrient: 'SELECT',
  nutrition_target: 'SELECT,INSERT',
  planned_actual_link: 'SELECT,INSERT,UPDATE',
  planned_meal: 'SELECT,INSERT',
  planned_meal_item: 'SELECT,INSERT,UPDATE',
  planned_meal_item_skip: 'SELECT,INSERT,UPDATE',
  platform_role_assignment: 'SELECT',
  product: 'SELECT',
  product_label_version: 'SELECT',
  product_nutrient: 'SELECT',
  product_serving: 'SELECT',
  profile: 'SELECT,INSERT,UPDATE,DELETE',
  provider_capability_definition: 'SELECT',
  raw_content: 'SELECT',
  recipe: 'SELECT,INSERT,UPDATE,DELETE',
  recipe_ingredient: 'SELECT,INSERT',
  recipe_instruction: 'SELECT,INSERT',
  recipe_personalized_variant: 'SELECT,INSERT,UPDATE',
  recipe_version: 'SELECT,INSERT',
  recovery: 'SELECT,INSERT',
  sleep: 'SELECT,INSERT',
  wearable_connection: 'SELECT,INSERT,UPDATE',
  weight_measurement: 'SELECT,INSERT',
  workout: 'SELECT,INSERT',
};

const ANON_EXECUTABLE = ['gtin_check_digit_valid(text)', 'gtin_is_product_identity(text)'];

const AUTHENTICATED_EXECUTABLE = [
  'admin_register_external_provider(jsonb)',
  'admin_update_external_provider(text,jsonb)',
  'can_manage_recipe(uuid)',
  'can_read_recipe(uuid)',
  'confirm_meal_plan(uuid,uuid,jsonb)',
  'correct_meal_item(uuid,uuid,uuid,jsonb,text)',
  'create_recipe_version(uuid,uuid,uuid,jsonb)',
  'current_account_id()',
  'enabled_provider_routes(provider_family,text)',
  'external_provider_audit_history(uuid)',
  'external_provider_connection_counts()',
  'generate_grocery_list(uuid,uuid,jsonb)',
  'gtin_check_digit_valid(text)',
  'gtin_is_product_identity(text)',
  'is_child_profile_created_by_caller(uuid)',
  'is_platform_admin()',
  'log_meal_items(uuid,uuid,jsonb)',
  'profile_access_scope(uuid)',
  'search_foods(text,text[],integer)',
  'write_planned_meal_items(uuid,uuid,uuid,uuid,jsonb)',
];

const ALL_TABLE_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];

async function tablePrivileges(pool: Pool, role: string): Promise<Record<string, string>> {
  const { rows } = await pool.query<{ relname: string; privileges: string }>(
    `select c.relname, string_agg(p, ',' order by array_position($2::text[], p)) as privileges
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       cross join unnest($2::text[]) p
      where n.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'S')
        and has_table_privilege($1, c.oid, p)
      group by c.relname`,
    [role, ALL_TABLE_PRIVILEGES],
  );
  return Object.fromEntries(rows.map((r) => [r.relname, r.privileges]));
}

// Directly callable functions (trigger functions cannot be called directly).
async function executableFunctions(pool: Pool, role: string): Promise<string[]> {
  const { rows } = await pool.query<{ fn: string }>(
    `select p.oid::regprocedure::text as fn
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prorettype <> 'trigger'::regtype
        and has_function_privilege($1, p.oid, 'EXECUTE')
      order by 1`,
    [role],
  );
  return rows.map((r) => r.fn);
}

describe('privilege model under Supabase default privileges', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = await rebuildTestDatabase('recipebook_api_test_layer12a1_privileges');
  }, 120000);

  afterAll(async () => {
    await pool.end();
  });

  it('anon holds no table privilege', async () => {
    expect(await tablePrivileges(pool, 'anon')).toEqual({});
  });

  it('authenticated holds exactly the validated table privileges (117)', async () => {
    const actual = await tablePrivileges(pool, 'authenticated');
    expect(actual).toEqual(AUTHENTICATED_TABLE_PRIVILEGES);
    expect(Object.values(actual).join(',').split(',')).toHaveLength(117);
  });

  it('anon can execute only the two pure gtin helpers', async () => {
    expect(await executableFunctions(pool, 'anon')).toEqual(ANON_EXECUTABLE);
  });

  it('authenticated can execute exactly the validated functions; internal helpers stay closed', async () => {
    expect(await executableFunctions(pool, 'authenticated')).toEqual(AUTHENTICATED_EXECUTABLE);
    // the six internal helpers the DEV drift exposed
    const helpers = [
      'meal_item_chain_root(uuid)',
      'lock_planning_key(text,uuid)',
      'planned_item_linkable(uuid,uuid)',
      'grocery_list_writable(uuid,uuid)',
      'grocery_shopping_writable(uuid,uuid)',
      'publish_product_label_version(uuid,product_nutrition_source,text,date,jsonb,jsonb)',
    ];
    for (const helper of helpers) {
      for (const role of ['anon', 'authenticated']) {
        const { rows } = await pool.query<{ ok: boolean }>(`select has_function_privilege($1, $2::regprocedure, 'EXECUTE') as ok`, [role, `public.${helper}`]);
        expect(rows[0]?.ok, `${role} ${helper}`).toBe(false);
      }
    }
  });

  it('objects created by later migrations get no automatic grant to anon/authenticated', async () => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('create table public.zz_privilege_probe (id int)');
      await client.query('create sequence public.zz_privilege_probe_seq');
      const { rows } = await client.query<{ privileges: boolean[] }>(
        `select array[
           has_table_privilege('anon', 'public.zz_privilege_probe', 'SELECT'),
           has_table_privilege('authenticated', 'public.zz_privilege_probe', 'SELECT'),
           has_sequence_privilege('anon', 'public.zz_privilege_probe_seq', 'USAGE'),
           has_sequence_privilege('authenticated', 'public.zz_privilege_probe_seq', 'USAGE')
         ] as privileges`,
      );
      expect(rows[0]?.privileges).toEqual([false, false, false, false]);
    } finally {
      await client.query('rollback');
      client.release();
    }
  });
});

describe('the harness reproduces the Supabase drift without the alignment migration', () => {
  let legacy: Pool;

  beforeAll(async () => {
    legacy = await rebuildTestDatabase('recipebook_api_test_layer12a1_privileges_pre', { stopBeforeMigration: ALIGNMENT });
  }, 120000);

  afterAll(async () => {
    await legacy.end();
  });

  it('anon and authenticated had ALL on tables and could execute internal helpers', async () => {
    const anonTables = await tablePrivileges(legacy, 'anon');
    expect(Object.keys(anonTables)).toHaveLength(56); // every public table
    expect(anonTables.profile).toBe(ALL_TABLE_PRIVILEGES.join(','));
    const anonFunctions = await executableFunctions(legacy, 'anon');
    expect(anonFunctions).toContain('meal_item_chain_root(uuid)');
    expect(anonFunctions).toContain('enabled_provider_routes(provider_family,text)');
  });
});
