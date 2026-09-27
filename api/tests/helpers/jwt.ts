import jwt from 'jsonwebtoken';

export const TEST_JWT_SECRET = 'test-only-jwt-secret-not-a-real-credential';

export interface SignOptions {
  aud?: string;
  expiresInSeconds?: number;
  secret?: string;
}

export function signTestToken(accountId: string, opts: SignOptions = {}): string {
  const { aud = 'authenticated', expiresInSeconds = 3600, secret = TEST_JWT_SECRET } = opts;
  const nowSeconds = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      sub: accountId,
      aud,
      role: 'authenticated',
      iat: nowSeconds,
      exp: nowSeconds + expiresInSeconds,
    },
    secret,
    { algorithm: 'HS256' },
  );
}
