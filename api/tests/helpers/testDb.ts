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
const TEST_DB_NAME = 'recipebook_api_test';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../supabase/migrations');
const SHIM_FILE = path.resolve(__dirname, '../fixtures/auth-shim.sql');
const SHIM_AFTER_MIGRATION = '20260825120900_audit_event.sql';

function testDbUrl(): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${TEST_DB_NAME}`;
  return url.toString();
}

export async function rebuildTestDatabase(): Promise<Pool> {
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`drop database if exists ${TEST_DB_NAME}`);
    await admin.query(`create database ${TEST_DB_NAME}`);
  } finally {
    await admin.end();
  }

  const client = new Client({ connectionString: testDbUrl() });
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

  return new Pool({ connectionString: testDbUrl() });
}
