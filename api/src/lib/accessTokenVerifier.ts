// Layer 12A.1 — Supabase access-token verification (JWKS + explicit legacy HS256).
//
// Supabase Auth is the only token issuer. Current Supabase projects sign
// access tokens with asymmetric JWT signing keys (ES256 or RS256) and publish
// the public keys at `<SUPABASE_URL>/auth/v1/.well-known/jwks.json`; projects
// that have not migrated still sign with the legacy shared HS256 secret.
// (Supabase docs: "JWT Signing Keys", "JSON Web Token (JWT)", "JWT Claims
// Reference".)
//
// The verification mode is chosen by configuration, never by the token:
//
//   jwks                    asymmetric only (ES256/RS256) against the JWKS.
//   legacy_hs256            HS256 only, with the legacy shared secret.
//   jwks_with_legacy_hs256  migration window: an HS256 token is checked with
//                           the secret, an ES256/RS256 token with the JWKS.
//
// The token's `alg` header only selects between the paths the mode allows,
// and each path pins its own algorithms, so an asymmetric token can never be
// "downgraded" to HS256 (or vice versa, the classic alg-confusion attack).
//
// Every accepted token must carry a valid signature, `exp` in the future, the
// configured `iss`, `aud: "authenticated"`, `role: "authenticated"`, a UUID
// `sub` and must not be an anonymous-user token. The Account id is the
// verified `sub` and nothing else.

import { createRemoteJWKSet, decodeProtectedHeader, errors as joseErrors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';

export const JWT_VERIFICATION_MODES = ['jwks', 'legacy_hs256', 'jwks_with_legacy_hs256'] as const;
export type JwtVerificationMode = (typeof JWT_VERIFICATION_MODES)[number];

/** Algorithms Supabase uses for asymmetric JWT signing keys. */
export const ASYMMETRIC_ALGORITHMS = ['ES256', 'RS256'] as const;
export const LEGACY_ALGORITHM = 'HS256';
export const EXPECTED_AUDIENCE = 'authenticated';
export const EXPECTED_ROLE = 'authenticated';

/** Supabase edge caches the JWKS for 10 minutes; we hold keys at most as long. */
export const JWKS_CACHE_MAX_AGE_MS = 10 * 60_000;
/** Minimum gap between JWKS refetches triggered by an unknown `kid`. */
export const JWKS_COOLDOWN_MS = 30_000;
export const JWKS_TIMEOUT_MS = 5_000;
export const CLOCK_TOLERANCE_SECONDS = 5;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `invalid`: the token is not acceptable (the client must sign in again).
 * `unavailable`: the verifier could not check it (JWKS unreachable), which is
 * a temporary server problem and must not end the user's session.
 */
export type VerifyResult = { ok: true; accountId: string } | { ok: false; reason: 'invalid' | 'unavailable' };

export interface AccessTokenVerifier {
  readonly mode: JwtVerificationMode;
  verify(token: string): Promise<VerifyResult>;
}

export interface AccessTokenVerifierConfig {
  mode: JwtVerificationMode;
  /** Required for the JWKS modes: `<SUPABASE_URL>/auth/v1`. Enforced on every path when set. */
  issuer?: string;
  /** JWKS endpoint (JWKS modes). Ignored when `jwks` is injected. */
  jwksUrl?: string;
  /** Injected key resolver (tests). Defaults to a cached remote JWKS for `jwksUrl`. */
  jwks?: JWTVerifyGetKey;
  /** Legacy shared secret (legacy modes only). */
  legacySecret?: string;
  jwksOptions?: { cacheMaxAgeMs?: number; cooldownMs?: number; timeoutMs?: number };
}

const INVALID = { ok: false, reason: 'invalid' } as const;
const UNAVAILABLE = { ok: false, reason: 'unavailable' } as const;

/** Verification failures that mean "this token is not acceptable". */
function isTokenRejection(error: unknown): boolean {
  return (
    error instanceof joseErrors.JWTClaimValidationFailed ||
    error instanceof joseErrors.JWTExpired ||
    error instanceof joseErrors.JWTInvalid ||
    error instanceof joseErrors.JWSInvalid ||
    error instanceof joseErrors.JWSSignatureVerificationFailed ||
    error instanceof joseErrors.JOSEAlgNotAllowed ||
    error instanceof joseErrors.JOSENotSupported ||
    error instanceof joseErrors.JWKSNoMatchingKey ||
    error instanceof joseErrors.JWKSMultipleMatchingKeys
  );
}

function checkSupabaseClaims(payload: JWTPayload): VerifyResult {
  if (typeof payload.sub !== 'string' || !UUID.test(payload.sub)) return INVALID;
  if (typeof payload.exp !== 'number') return INVALID;
  if (payload.role !== EXPECTED_ROLE) return INVALID;
  // Anonymous sign-in is not an approved sign-in method (37_Auth §3).
  if (payload.is_anonymous === true) return INVALID;
  return { ok: true, accountId: payload.sub };
}

export function createAccessTokenVerifier(config: AccessTokenVerifierConfig): AccessTokenVerifier {
  const usesJwks = config.mode === 'jwks' || config.mode === 'jwks_with_legacy_hs256';
  const usesLegacy = config.mode === 'legacy_hs256' || config.mode === 'jwks_with_legacy_hs256';

  if (usesJwks && !config.issuer) throw new Error(`JWT verification mode ${config.mode} requires an issuer`);
  if (usesJwks && !config.jwks && !config.jwksUrl) throw new Error(`JWT verification mode ${config.mode} requires a JWKS URL`);
  if (usesLegacy && (!config.legacySecret || config.legacySecret.length < 16)) {
    throw new Error(`JWT verification mode ${config.mode} requires the legacy JWT secret`);
  }

  const jwks: JWTVerifyGetKey | null = usesJwks
    ? (config.jwks ??
      createRemoteJWKSet(new URL(config.jwksUrl as string), {
        cacheMaxAge: config.jwksOptions?.cacheMaxAgeMs ?? JWKS_CACHE_MAX_AGE_MS,
        cooldownDuration: config.jwksOptions?.cooldownMs ?? JWKS_COOLDOWN_MS,
        timeoutDuration: config.jwksOptions?.timeoutMs ?? JWKS_TIMEOUT_MS,
      }))
    : null;
  const secret = usesLegacy ? new TextEncoder().encode(config.legacySecret) : null;

  const common = {
    audience: EXPECTED_AUDIENCE,
    requiredClaims: ['exp', 'sub'],
    clockTolerance: CLOCK_TOLERANCE_SECONDS,
    ...(config.issuer ? { issuer: config.issuer } : {}),
  };

  return {
    mode: config.mode,
    async verify(token) {
      let alg: string | undefined;
      try {
        alg = decodeProtectedHeader(token).alg;
      } catch {
        return INVALID;
      }

      try {
        if (alg === LEGACY_ALGORITHM && secret) {
          const { payload } = await jwtVerify(token, secret, { ...common, algorithms: [LEGACY_ALGORITHM] });
          return checkSupabaseClaims(payload);
        }
        if (alg && (ASYMMETRIC_ALGORITHMS as readonly string[]).includes(alg) && jwks) {
          const { payload } = await jwtVerify(token, jwks, { ...common, algorithms: [...ASYMMETRIC_ALGORITHMS] });
          return checkSupabaseClaims(payload);
        }
        // An algorithm this mode does not allow (including "none").
        return INVALID;
      } catch (error) {
        return isTokenRejection(error) ? INVALID : UNAVAILABLE;
      }
    },
  };
}
