// Layer 4B — integration-test-only ScopedDbClient, same RLS-session-GUC
// simulation as Layer 4A's PgHarnessProfileRepository (tests/helpers/
// pgHarnessProfileRepository.ts): reproduces the session context PostgREST
// sets after verifying a token, directly over a raw Postgres connection,
// against the real, already-migrated schema. Never used by production code
// (see src/lib/supabaseScopedDb.ts for that).

import { types, type Pool, type PoolClient } from 'pg';
import type { AuthContext } from '../../src/types/express';
import { assertSafeIdentifier, type ScopedDbClient, type ScopedDbFactory, type SelectOptions } from '../../src/lib/scopedDb';

// node-postgres returns `numeric` columns as strings by default (to avoid
// silent precision loss on values it cannot know the safe range of). The
// production path (PostgREST) serializes `numeric` as a JSON number, and
// every Layer 4B Zod DTO schema declares these fields z.number() — so the
// harness parses them as JS numbers too, to match the real contract rather
// than a node-postgres implementation detail. Process-wide, but this module
// is test-only and never imported by production code (src/index.ts never
// reaches it), so the scope of this side effect is the test process only.
types.setTypeParser(1700 /* numeric */, (value: string) => parseFloat(value));

// `date` (1082): pg's default parser converts to a JS Date; PostgREST
// instead returns the plain "YYYY-MM-DD" text. Passing the raw wire text
// straight through matches PostgREST exactly (it already arrives in this
// form) and avoids a UTC-midnight round-trip that could shift by a day
// under a non-UTC TZ.
types.setTypeParser(1082 /* date */, (value: string) => value);

// `timestamptz` (1184): converts Postgres's default text output
// ("YYYY-MM-DD HH:MI:SS[.ffffff]+TZ") to the same ISO-8601 shape PostgREST
// serializes. Note: truncates to millisecond precision (JS Date's native
// resolution) where PostgREST may preserve up to microseconds — every
// Layer 4B DTO schema accepts variable sub-second precision, so this does
// not affect validity, only exact-string equality, which no Layer 4B test
// relies on for this field.
types.setTypeParser(1184 /* timestamptz */, (value: string) => new Date(value).toISOString());

function assertSafeColumnList(columns: string): void {
  if (!/^[a-z0-9_,\s]+$/.test(columns)) {
    throw new Error(`Unsafe column list rejected: ${columns}`);
  }
}

/** PostgREST receives insert/update values as a JSON body, so a JS array
 * written to a column is a JSON array (jsonb). node-postgres would instead
 * send it as a PostgreSQL array literal; JSON-encode it to match the
 * production client. (No write path in this codebase sends a native SQL
 * array column value.) */
function asBodyValue(value: unknown): unknown {
  return Array.isArray(value) ? JSON.stringify(value) : value;
}

class PgHarnessScopedDbClient implements ScopedDbClient {
  constructor(
    private readonly pool: Pool,
    private readonly auth: AuthContext,
  ) {}

  private async withUserContext<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query('select set_config($1, $2, true)', ['request.jwt.claim.sub', this.auth.accountId]);
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

  async select<T>(table: string, { columns, eq, in: inFilter, order, limit }: SelectOptions): Promise<T[]> {
    assertSafeIdentifier(table);
    assertSafeColumnList(columns);
    return this.withUserContext(async (client) => {
      const values: unknown[] = [];
      const conditions: string[] = [];
      for (const [key, value] of Object.entries(eq ?? {})) {
        assertSafeIdentifier(key);
        values.push(value);
        conditions.push(`${key} = $${values.length}`);
      }
      for (const [key, list] of Object.entries(inFilter ?? {})) {
        assertSafeIdentifier(key);
        values.push([...list]);
        conditions.push(`${key} = any($${values.length})`);
      }
      let sql = `select ${columns} from ${table}`;
      if (conditions.length) sql += ` where ${conditions.join(' and ')}`;
      if (order) {
        assertSafeIdentifier(order.column);
        sql += ` order by ${order.column} ${order.ascending === false ? 'desc' : 'asc'}`;
      }
      if (limit) {
        values.push(limit);
        sql += ` limit $${values.length}`;
      }
      const { rows } = await client.query(sql, values);
      return rows as T[];
    });
  }

  async insert<T>(table: string, values: Record<string, unknown>, returningColumns: string): Promise<T> {
    assertSafeIdentifier(table);
    assertSafeColumnList(returningColumns);
    return this.withUserContext(async (client) => {
      const keys = Object.keys(values);
      keys.forEach(assertSafeIdentifier);
      const placeholders = keys.map((_, i) => `$${i + 1}`);
      const sql = `insert into ${table} (${keys.join(', ')}) values (${placeholders.join(', ')}) returning ${returningColumns}`;
      const { rows } = await client.query(sql, Object.values(values).map(asBodyValue));
      return rows[0] as T;
    });
  }

  async update<T>(table: string, eq: Record<string, unknown>, values: Record<string, unknown>, returningColumns: string): Promise<T | null> {
    assertSafeIdentifier(table);
    assertSafeColumnList(returningColumns);
    return this.withUserContext(async (client) => {
      const params: unknown[] = [];
      const setKeys = Object.keys(values);
      setKeys.forEach(assertSafeIdentifier);
      const setClauses = setKeys.map((k) => {
        params.push(asBodyValue(values[k]));
        return `${k} = $${params.length}`;
      });
      const whereClauses = Object.entries(eq).map(([k, v]) => {
        assertSafeIdentifier(k);
        params.push(v);
        return `${k} = $${params.length}`;
      });
      const sql = `update ${table} set ${setClauses.join(', ')} where ${whereClauses.join(' and ')} returning ${returningColumns}`;
      const { rows } = await client.query(sql, params);
      return (rows[0] as T | undefined) ?? null;
    });
  }

  async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    assertSafeIdentifier(fn);
    return this.withUserContext(async (client) => {
      const keys = Object.keys(args);
      keys.forEach(assertSafeIdentifier);
      const params = keys.map((_, i) => `$${i + 1}`);
      const namedArgs = keys.map((k, i) => `${k} := ${params[i]}`);
      const sql = `select ${fn}(${namedArgs.join(', ')}) as result`;
      const { rows } = await client.query(sql, Object.values(args));
      return rows[0]?.result as T;
    });
  }

  async rpcRows<T>(fn: string, args: Record<string, unknown>): Promise<T[]> {
    assertSafeIdentifier(fn);
    return this.withUserContext(async (client) => {
      const keys = Object.keys(args);
      keys.forEach(assertSafeIdentifier);
      const namedArgs = keys.map((k, i) => `${k} := $${i + 1}`);
      const sql = `select * from ${fn}(${namedArgs.join(', ')})`;
      const { rows } = await client.query(sql, Object.values(args));
      return rows as T[];
    });
  }
}

export class PgHarnessScopedDbFactory implements ScopedDbFactory {
  constructor(private readonly pool: Pool) {}

  forUser(auth: AuthContext): ScopedDbClient {
    return new PgHarnessScopedDbClient(this.pool, auth);
  }
}
