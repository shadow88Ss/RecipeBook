// Integration-test-only: rebuilds a throwaway Postgres database from the
// real, already-approved Layer 1-3 migration chain plus the sandbox auth
// shim (tests/fixtures/auth-shim.sql), then hands back a Pool for the
// PgHarnessProfileRepository to use. This exercises the actual committed
// RLS policies and profile_access_scope() function — nothing about RLS
// behavior is mocked.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Client, Pool } from 'pg';

const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgresql://postgres:test_local_only_pw@127.0.0.1:5432/postgres';
const DEFAULT_TEST_DB_NAME = 'recipebook_api_test';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../supabase/migrations');
const SHIM_FILE = path.resolve(__dirname, '../fixtures/auth-shim.sql');
const SHIM_AFTER_MIGRATION = '20260825120900_audit_event.sql';

function testDbUrl(dbName: string): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${dbName}`;
  return url.toString();
}

/**
 * Each integration test FILE must pass its own distinct `dbName` (e.g. the
 * file's own name). Vitest runs test files in parallel by default, and this
 * function drops-then-creates a database by name — two files racing on the
 * same name corrupts both (a `create database` colliding with a concurrent
 * `drop`/`create`, or one file's rebuild wiping data another file is mid-
 * test on). Defaults to the original fixed name so any pre-existing
 * single-file caller (Layer 4A's profiles.api.test.ts) needs no change.
 */
export async function rebuildTestDatabase(dbName: string = DEFAULT_TEST_DB_NAME): Promise<Pool> {
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`drop database if exists ${dbName}`);
    await admin.query(`create database ${dbName}`);
  } finally {
    await admin.end();
  }

  const client = new Client({ connectionString: testDbUrl(dbName) });
  await client.connect();
  try {
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query(sql);
      if (file === SHIM_AFTER_MIGRATION) {
        await client.query(await readFile(SHIM_FILE, 'utf8'));
      }
    }
  } finally {
    await client.end();
  }

  return new Pool({ connectionString: testDbUrl(dbName) });
}
