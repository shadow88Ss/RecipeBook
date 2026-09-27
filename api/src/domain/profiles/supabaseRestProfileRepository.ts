// Layer 4A §4/§17 — the production ProfileRepository.
//
// Talks to Supabase's PostgREST (table/RPC) endpoints using the anon key
// plus, per call, the caller's own verified bearer token in the
// Authorization header. PostgREST independently verifies that token and
// sets the Postgres session's RLS context (auth.uid()) before running any
// query — this repository never opens a raw/elevated Postgres connection
// and never uses a service-role key (spec §17, §19). Not exercised against
// a live Supabase project in this environment (spec §20) — see the Layer
// 4A report's "External configuration required" section.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext } from '../../types/express';
import { ACCESS_SCOPES, type AccessScope, type ProfileRepository, type ProfileRow, type ProfileWithScope } from './profile.repository';

const PROFILE_COLUMNS = 'id, account_id, display_name, is_child, date_of_birth, created_at';

type ScopedClient = SupabaseClient;

function isAccessScope(value: unknown): value is AccessScope {
  return typeof value === 'string' && (ACCESS_SCOPES as readonly string[]).includes(value);
}

export class SupabaseRestProfileRepository implements ProfileRepository {
  constructor(
    private readonly supabaseUrl: string,
    private readonly anonKey: string,
  ) {}

  private clientFor(auth: AuthContext): ScopedClient {
    return createClient(this.supabaseUrl, this.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${auth.accessToken}` } },
    });
  }

  async listAccessibleProfiles(auth: AuthContext): Promise<ProfileWithScope[]> {
    const client = this.clientFor(auth);
    const { data, error } = await client
      .from('profile')
      .select(PROFILE_COLUMNS)
      .is('deleted_at', null)
      .order('created_at', { ascending: true });

    if (error) throw error;
    const rows = (data ?? []) as ProfileRow[];

    // profile_access_scope is evaluated once per row here (small, bounded
    // set — an Account's own profiles plus guarded children). A single
    // query joining a view could remove this N+1 in a later phase; left as
    // a noted future optimization rather than introducing an unreviewed
    // RLS-bearing view now (see profile.service.ts comment).
    const withNulls = await Promise.all(
      rows.map(async (row) => {
        const scope = await this.resolveScope(client, row.id);
        return { ...row, access_scope: scope };
      }),
    );
    return withNulls.filter((row): row is ProfileWithScope => row.access_scope !== null);
  }

  async getProfileById(auth: AuthContext, profileId: string): Promise<ProfileWithScope | null> {
    const client = this.clientFor(auth);
    const { data, error } = await client.from('profile').select(PROFILE_COLUMNS).eq('id', profileId).is('deleted_at', null).maybeSingle();

    if (error) throw error;
    if (!data) return null;

    const row = data as ProfileRow;
    const scope = await this.resolveScope(client, row.id);
    if (!scope) return null;
    return { ...row, access_scope: scope };
  }

  private async resolveScope(client: ScopedClient, profileId: string): Promise<AccessScope | null> {
    const { data, error } = await client.rpc('profile_access_scope', { target_profile_id: profileId });
    if (error) throw error;
    return isAccessScope(data) ? data : null;
  }
}
