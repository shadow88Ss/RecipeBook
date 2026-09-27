// Layer 4A §20 — local RLS simulation harness, integration-test-only.
//
// This is NOT a substitute for PostgREST or for live Supabase JWT
// verification: it never verifies a JWT signature at all. It only
// reproduces the RLS *session context* PostgREST sets after it has
// verified a token (the `request.jwt.claim.sub` GUC + `authenticated`
// role) directly over a raw Postgres connection, against the real,
// already-migrated Layers 1-3 schema — so integration tests exercise the
// real RLS policies and the real profile_access_scope() function, not a
// mock of them. JWT verification itself is tested for real, separately,
// in tests/unit/auth.middleware.test.ts using actually signed/verified
// tokens. Production traffic never uses this class or this connection
// style — see src/domain/profiles/supabaseRestProfileRepository.ts.
//
// Requires a Postgres role permitted to `SET LOCAL ROLE authenticated`
// (i.e. a superuser or a role granted membership in `authenticated`) —
// tests connect as the local sandbox's `postgres` role, exactly as every
// prior layer's manual verification did.

import { Pool } from 'pg';
import type { AuthContext } from '../../src/types/express';
import type { AccessScope, ProfileRepository, ProfileRow, ProfileWithScope } from '../../src/domain/profiles/profile.repository';

// date_of_birth (date) and created_at (timestamptz) are cast to text so the
// harness returns the same JSON-string shapes PostgREST would return in
// production, rather than node-postgres's parsed Date objects.
const PROFILE_COLUMNS = 'id, account_id, display_name, is_child, date_of_birth::text, to_char(created_at at time zone \'UTC\', \'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\') as created_at';

export class PgHarnessProfileRepository implements ProfileRepository {
  constructor(private readonly pool: Pool) {}

  private async withUserContext<T>(auth: AuthContext, fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query('select set_config($1, $2, true)', ['request.jwt.claim.sub', auth.accountId]);
      await client.query('set local role authenticated');
      const result = await fn(client);
      await client.query('commit');
      return result;
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async listAccessibleProfiles(auth: AuthContext): Promise<ProfileWithScope[]> {
    return this.withUserContext(auth, async (client) => {
      const { rows } = await client.query<ProfileRow>(
        `select ${PROFILE_COLUMNS} from profile where deleted_at is null order by created_at asc`,
      );
      const withScope: ProfileWithScope[] = [];
      for (const row of rows) {
        const scope = await this.resolveScope(client, row.id);
        if (scope) withScope.push({ ...row, access_scope: scope });
      }
      return withScope;
    });
  }

  async getProfileById(auth: AuthContext, profileId: string): Promise<ProfileWithScope | null> {
    return this.withUserContext(auth, async (client) => {
      const { rows } = await client.query<ProfileRow>(
        `select ${PROFILE_COLUMNS} from profile where id = $1 and deleted_at is null`,
        [profileId],
      );
      const row = rows[0];
      if (!row) return null;
      const scope = await this.resolveScope(client, row.id);
      if (!scope) return null;
      return { ...row, access_scope: scope };
    });
  }

  private async resolveScope(client: import('pg').PoolClient, profileId: string): Promise<AccessScope | null> {
    const { rows } = await client.query<{ profile_access_scope: AccessScope | null }>(
      'select profile_access_scope($1)',
      [profileId],
    );
    return rows[0]?.profile_access_scope ?? null;
  }
}
