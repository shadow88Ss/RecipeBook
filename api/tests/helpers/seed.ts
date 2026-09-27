// Integration-test-only fixture data. Inserted directly as the `postgres`
// superuser (bypassing RLS) — this seeds state to read back through the
// API under test, it does not itself exercise write-path RLS (that is
// already covered by the Layer 2 RLS Security Report).

import type { Pool } from 'pg';

export const SEED = {
  accountA: 'a0a0a0a0-0000-4000-8000-000000000001',
  accountB: 'a0a0a0a0-0000-4000-8000-000000000002',
  accountFullManagement: 'a0a0a0a0-0000-4000-8000-000000000003',
  accountViewOnly: 'a0a0a0a0-0000-4000-8000-000000000004',
  accountPediatric: 'a0a0a0a0-0000-4000-8000-000000000005',
  accountRevoked: 'a0a0a0a0-0000-4000-8000-000000000006',
  accountUnrelated: 'a0a0a0a0-0000-4000-8000-000000000007',

  profileA: 'b0b0b0b0-0000-4000-8000-000000000001',
  profileB: 'b0b0b0b0-0000-4000-8000-000000000002',
  profileChild: 'b0b0b0b0-0000-4000-8000-000000000003',
} as const;

export async function seedScenario(pool: Pool): Promise<void> {
  const accounts = [
    [SEED.accountA, 'account-a@example.com'],
    [SEED.accountB, 'account-b@example.com'],
    [SEED.accountFullManagement, 'guardian-full@example.com'],
    [SEED.accountViewOnly, 'guardian-view@example.com'],
    [SEED.accountPediatric, 'guardian-pediatric@example.com'],
    [SEED.accountRevoked, 'guardian-revoked@example.com'],
    [SEED.accountUnrelated, 'unrelated@example.com'],
  ];
  for (const [id, email] of accounts) {
    await pool.query('insert into account (id, email, display_name) values ($1, $2, $3)', [id, email, email]);
  }

  await pool.query(
    'insert into profile (id, account_id, display_name, is_child) values ($1, $2, $3, false)',
    [SEED.profileA, SEED.accountA, 'Profile A'],
  );
  await pool.query(
    'insert into profile (id, account_id, display_name, is_child) values ($1, $2, $3, false)',
    [SEED.profileB, SEED.accountB, 'Profile B'],
  );
  await pool.query(
    'insert into profile (id, account_id, display_name, is_child, date_of_birth) values ($1, $2, $3, true, $4)',
    [SEED.profileChild, SEED.accountFullManagement, 'Child Profile', '2018-06-01'],
  );

  const grants: Array<[string, string, string, string | null]> = [
    [SEED.accountFullManagement, SEED.profileChild, 'full_management', null],
    [SEED.accountViewOnly, SEED.profileChild, 'view_only', null],
    [SEED.accountPediatric, SEED.profileChild, 'pediatric_weight_management', null],
    [SEED.accountRevoked, SEED.profileChild, 'view_only', 'now()'],
  ];
  for (const [guardianId, childProfileId, scope, revoked] of grants) {
    await pool.query(
      `insert into guardian_authorization
         (guardian_account_id, child_profile_id, authorization_scope, granted_by_account_id, consented_at, revoked_at, revoked_by_account_id)
       values ($1, $2, $3, $1, now(), ${revoked ? 'now()' : 'null'}, ${revoked ? '$1' : 'null'})`,
      [guardianId, childProfileId, scope],
    );
  }
}
