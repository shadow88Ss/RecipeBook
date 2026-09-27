// Layer 4B — production ScopedDbClient, built on @supabase/supabase-js,
// exactly the same pattern as Layer 4A's SupabaseRestProfileRepository:
// PostgREST/RPC endpoints, the caller's own bearer token, never a
// service-role key. Not exercised against a live Supabase project in this
// environment — see the Layer 4B report's "External configuration".

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext } from '../types/express';
import type { ScopedDbClient, ScopedDbFactory, SelectOptions } from './scopedDb';

// No generated Database schema type exists for this project (Phase 1 has no
// codegen step), so supabase-js's table/RPC builders are used generically
// here — `any` at this one internal boundary only. Every public method on
// SupabaseScopedDbClient stays fully generic over its own <T>, so callers
// (every Layer 4B service) get normal type safety; this looseness never
// leaks past this file.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- documented above: no generated Database schema type exists yet.
type AnyClient = SupabaseClient<any, any, any>;

class SupabaseScopedDbClient implements ScopedDbClient {
  constructor(private readonly client: AnyClient) {}

  async select<T>(table: string, { columns, eq, in: inFilter, order, limit }: SelectOptions): Promise<T[]> {
    let query = this.client.from(table).select(columns);
    for (const [key, value] of Object.entries(eq ?? {})) {
      query = query.eq(key, value);
    }
    for (const [key, values] of Object.entries(inFilter ?? {})) {
      query = query.in(key, [...values]);
    }
    if (order) query = query.order(order.column, { ascending: order.ascending ?? true });
    if (limit) query = query.limit(limit);
    const { data, error } = await query;
    if (error) throw error;
    return (data ?? []) as T[];
  }

  async insert<T>(table: string, values: Record<string, unknown>, returningColumns: string): Promise<T> {
    const { data, error } = await this.client.from(table).insert(values).select(returningColumns).single();
    if (error) throw error;
    return data as T;
  }

  async update<T>(table: string, eq: Record<string, unknown>, values: Record<string, unknown>, returningColumns: string): Promise<T | null> {
    let query = this.client.from(table).update(values);
    for (const [key, value] of Object.entries(eq)) {
      query = query.eq(key, value);
    }
    const { data, error } = await query.select(returningColumns).maybeSingle();
    if (error) throw error;
    return (data as T | null) ?? null;
  }

  async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await this.client.rpc(fn, args);
    if (error) throw error;
    return data as T;
  }

  async rpcRows<T>(fn: string, args: Record<string, unknown>): Promise<T[]> {
    const { data, error } = await this.client.rpc(fn, args);
    if (error) throw error;
    return (data ?? []) as T[];
  }
}

export class SupabaseScopedDbFactory implements ScopedDbFactory {
  constructor(
    private readonly supabaseUrl: string,
    private readonly anonKey: string,
  ) {}

  forUser(auth: AuthContext): ScopedDbClient {
    const client: AnyClient = createClient(this.supabaseUrl, this.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${auth.accessToken}` } },
    });
    return new SupabaseScopedDbClient(client);
  }
}
