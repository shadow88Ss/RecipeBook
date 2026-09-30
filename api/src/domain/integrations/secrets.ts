// Layer 11C — platform secret references.
//
// The registry stores only a REFERENCE to a secret (`env:NAME`), never the
// secret. The approved scheme in this layer is `env:` — the deployment's
// environment/secret-manager injection that already supplies
// SUPABASE_JWT_SECRET. Other stores (e.g. Supabase Vault) are future
// resolvers behind the same interface and need their own approval; the
// database check on external_provider.secret_reference only admits `env:`.
//
// Secrets are resolved in the API process at call time, passed to the
// adapter, and never returned, logged or stored.

export const SECRET_REFERENCE_PATTERN = /^env:[A-Z][A-Z0-9_]{0,127}$/;

export interface SecretResolver {
  /** True when the reference resolves to a non-empty value. */
  isConfigured(reference: string): boolean;
  /** The secret value, or null. Callers must not log or return it. */
  resolve(reference: string): string | null;
}

export class EnvSecretResolver implements SecretResolver {
  constructor(private readonly source: NodeJS.ProcessEnv = process.env) {}

  resolve(reference: string): string | null {
    if (!SECRET_REFERENCE_PATTERN.test(reference)) return null;
    const value = this.source[reference.slice('env:'.length)];
    return value && value.length > 0 ? value : null;
  }

  isConfigured(reference: string): boolean {
    return this.resolve(reference) !== null;
  }
}
