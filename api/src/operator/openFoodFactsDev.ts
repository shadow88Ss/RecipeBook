// Option A (DEV) — operator command: configure and verify the existing Open
// Food Facts adapter through the Layer 11C admin API. NOT part of the API
// server (app.ts never imports this). Runs on the operator's own machine.
//
//   npm run ops:off -- <command> --project-ref <ref> [--env-file ../mobile/.env.local]
//
//   status             provider state as the admin API reports it
//   configure          PATCH: User-Agent configuration, environment production,
//                      barcode_lookup + nutrition_lookup on, product_search off,
//                      enabled. Needs OFF_CONTACT_EMAIL.
//   test               admin connection test (one real Open Food Facts read)
//   lookup <barcode>   consumer barcode lookup as the signed-in user, plus
//                      persistence and exposure checks
//   disable            PATCH enabled: false (rollback)
//
// Inputs: the API and Supabase URLs and the publishable key come from the
// mobile env file (public by design). OPS_EMAIL and OPS_PASSWORD (and
// OFF_CONTACT_EMAIL for configure) come from the operator's shell. Nothing
// here prints a token, password, key or the contact email: only booleans,
// counts, statuses and provider data that is public anyway.

import { readFileSync } from 'node:fs';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const PROVIDER = 'open_food_facts';
const REFERENCE_TABLES = ['product', 'barcode', 'product_label_version', 'product_nutrient', 'product_serving'] as const;
const COMMANDS = ['status', 'configure', 'test', 'lookup', 'disable'] as const;
type Command = (typeof COMMANDS)[number];

export interface OpsArgs {
  command: Command;
  barcode: string | null;
  projectRef: string;
  envFile: string;
}

export function parseOpsArgs(argv: string[]): OpsArgs {
  const get = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const command = argv[0] as Command;
  if (!COMMANDS.includes(command)) throw new Error(`Usage: npm run ops:off -- <${COMMANDS.join('|')}> [barcode] --project-ref <ref> [--env-file <path>]`);
  const projectRef = get('project-ref');
  if (!projectRef || !/^[a-z0-9]{6,40}$/.test(projectRef)) throw new Error('--project-ref must be the Supabase project ref');
  const barcode = command === 'lookup' ? (argv[1] ?? null) : null;
  if (command === 'lookup' && (!barcode || !/^[0-9]{8,14}$/.test(barcode))) throw new Error('lookup needs a barcode of 8-14 digits');
  return { command, barcode, projectRef, envFile: get('env-file') ?? '../mobile/.env.local' };
}

/** Reads only the three public values the mobile app already ships with. */
export function readPublicEnv(text: string, projectRef: string) {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(EXPO_PUBLIC_[A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) values.set(m[1]!, m[2]!.replace(/^["']|["']$/g, ''));
  }
  const api = (values.get('EXPO_PUBLIC_API_BASE_URL') ?? '').replace(/\/+$/, '');
  const supabaseUrl = values.get('EXPO_PUBLIC_SUPABASE_URL') ?? '';
  const anonKey = values.get('EXPO_PUBLIC_SUPABASE_ANON_KEY') ?? '';
  if (!api.startsWith('https://')) throw new Error('EXPO_PUBLIC_API_BASE_URL must be an https URL');
  if (new URL(supabaseUrl).hostname !== `${projectRef}.supabase.co`) throw new Error(`EXPO_PUBLIC_SUPABASE_URL is not project ${projectRef}`);
  if (!anonKey || /^sb_secret_/.test(anonKey)) throw new Error('EXPO_PUBLIC_SUPABASE_ANON_KEY must be the publishable key');
  return { api, supabaseUrl, anonKey };
}

/** Every path in a JSON value whose key or string value matches a needle. */
export function findExposures(value: unknown, needles: { keys: RegExp; values: string[] }, path = '$'): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => findExposures(v, needles, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => [...(needles.keys.test(k) ? [`${path}.${k}`] : []), ...findExposures(v, needles, `${path}.${k}`)]);
  }
  if (typeof value === 'string' && needles.values.some((n) => n && value.toLowerCase().includes(n.toLowerCase()))) return [path];
  return [];
}

const SENSITIVE_KEYS = /configuration|secret|credential|contact|user.?agent|authorization|token|password|health|priority/i;

function sanitizedProvider(p: Record<string, unknown>) {
  const config = (p.configuration ?? {}) as Record<string, unknown>;
  return {
    provider_key: p.provider_key,
    enabled: p.enabled,
    environment: p.environment,
    deployment_environment: p.deployment_environment,
    credential_model: p.credential_model,
    capabilities: p.capabilities,
    adapter: p.adapter,
    configuration: Object.fromEntries(Object.entries(config).map(([k, v]) => [k, k === 'contact_email' ? (typeof v === 'string' && v.includes('@') ? 'set' : 'missing') : v])),
    health: p.health,
  };
}

async function main(): Promise<number> {
  const args = parseOpsArgs(process.argv.slice(2));
  const env = readPublicEnv(readFileSync(args.envFile, 'utf8'), args.projectRef);
  const email = process.env.OPS_EMAIL ?? '';
  const password = process.env.OPS_PASSWORD ?? '';
  if (!email || !password) throw new Error('Set OPS_EMAIL and OPS_PASSWORD in your shell (hidden prompt for the password).');

  const supabase: SupabaseClient = createClient(env.supabaseUrl, env.anonKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw new Error(`sign-in failed: ${error?.code ?? 'no session'}`);
  const token = data.session.access_token;
  console.log(`signed in; API ${env.api}`);

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${env.api}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { non_json_body_length: text.length };
    }
    return { status: res.status, json: json as Record<string, unknown> };
  };
  const show = (label: string, value: unknown) => console.log(`${label}:\n${JSON.stringify(value, null, 2)}`);
  const adminError = (r: { status: number; json: Record<string, unknown> }) => {
    const e = (r.json?.error ?? r.json) as Record<string, unknown>;
    show(`admin API answered HTTP ${r.status}`, { code: e?.code, message: e?.message, details: e?.details });
    return 1;
  };

  try {
    if (args.command === 'status') {
      const r = await call('GET', `/v1/admin/integrations/${PROVIDER}`);
      if (r.status !== 200) return adminError(r);
      show('provider', sanitizedProvider(r.json));
      return 0;
    }

    if (args.command === 'configure' || args.command === 'disable') {
      const contact = process.env.OFF_CONTACT_EMAIL ?? '';
      if (args.command === 'configure' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contact)) throw new Error('Set OFF_CONTACT_EMAIL to the contact address for the User-Agent.');
      const body =
        args.command === 'disable'
          ? { enabled: false }
          : {
              enabled: true,
              environment: 'production',
              configuration: { app_name: 'MyRecipeBook', app_version: '1.0', contact_email: contact },
              capabilities: [
                { capability: 'barcode_lookup', enabled: true, priority: 30 },
                { capability: 'nutrition_lookup', enabled: true, priority: 30 },
                { capability: 'product_search', enabled: false, priority: 30 },
              ],
            };
      const r = await call('PATCH', `/v1/admin/integrations/${PROVIDER}`, body);
      if (r.status !== 200) return adminError(r);
      show('provider after change', sanitizedProvider(r.json));
      return 0;
    }

    if (args.command === 'test') {
      const r = await call('POST', `/v1/admin/integrations/${PROVIDER}/test`);
      if (r.status !== 200) return adminError(r);
      show('connection test', r.json);
      return 0;
    }

    // lookup: the consumer flow, exactly as the mobile app calls it.
    const counts = async () => {
      const out: Record<string, number | string> = {};
      for (const table of REFERENCE_TABLES) {
        const { count, error: e } = await supabase.from(table).select('*', { count: 'exact', head: true });
        out[table] = e ? `error ${e.code}` : (count ?? 0);
      }
      return out;
    };
    const before = await counts();
    const r = await call('GET', `/v1/products/barcode/${args.barcode}/lookup`);
    const after = await counts();
    if (r.status !== 200) {
      show(`lookup answered HTTP ${r.status}`, r.json);
      return 1;
    }
    const candidates = (r.json.candidates ?? []) as Array<{
      status?: string;
      loggable?: boolean;
      provider_key?: string;
      external_product_id?: string;
      brand_name?: string | null;
      product_name?: string | null;
      nutrient_mapping_status?: string;
      nutrition?: unknown[];
      provenance?: { attribution?: { required?: boolean; licence?: string | null } };
      storage?: unknown;
    }>;
    show('lookup', {
      source: r.json.source,
      match: r.json.match ?? null,
      product_returned: r.json.product !== null && r.json.product !== undefined,
      next_step: r.json.next_step ?? null,
      external_lookup: r.json.external_lookup,
      candidates: candidates.map((c) => ({
        status: c.status,
        loggable: c.loggable,
        provider_key: c.provider_key,
        external_product_id: c.external_product_id,
        brand_name: c.brand_name,
        product_name: c.product_name,
        nutrient_mapping_status: c.nutrient_mapping_status,
        nutrition_bases: (c.nutrition ?? []).length,
        provenance: c.provenance,
        storage: c.storage,
      })),
    });

    const exposures = findExposures(r.json, { keys: SENSITIVE_KEYS, values: [process.env.OFF_CONTACT_EMAIL ?? '', 'MyRecipeBook/', 'off:off'] });
    // Runtime routing RPC: callable by any signed-in user (Layer 11D design).
    const routes = await supabase.rpc('enabled_provider_routes', { p_family: 'product_data', p_capability: 'barcode_lookup' });
    const offRoute = ((routes.data ?? []) as Array<Record<string, unknown>>).find((row) => row.provider_key === PROVIDER);
    const routeConfig = (offRoute?.configuration ?? {}) as Record<string, unknown>;
    show('checks', {
      reference_rows_before: before,
      reference_rows_after: after,
      reference_rows_unchanged: JSON.stringify(before) === JSON.stringify(after),
      all_candidates_unconfirmed: candidates.every((c) => c.status === 'unconfirmed_external_candidate'),
      all_candidates_not_loggable: candidates.every((c) => c.loggable === false),
      all_candidates_attributed: candidates.every((c) => c.provenance?.attribution?.required === true && !!c.provenance?.attribution?.licence),
      lookup_response_sensitive_paths: exposures,
      routing_rpc_visible_to_signed_in_users: routes.error ? `error ${routes.error.code}` : !!offRoute,
      routing_rpc_returns_contact_email: typeof routeConfig.contact_email === 'string',
      routing_rpc_returns_secret_reference: offRoute ? 'secret_reference' in offRoute : false,
    });
    return 0;
  } finally {
    await supabase.auth.signOut().catch(() => undefined);
  }
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : 'operator command failed');
      process.exit(1);
    },
  );
}
