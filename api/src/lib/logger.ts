// Layer 4A §10 — structured, safe logging.
//
// Two layers of defense against sensitive data reaching logs:
//   1. The logger itself never receives full request/response bodies or
//      header blocks — call sites only ever pass small, explicitly-built
//      objects (see middleware/requestLogging.ts), so there is nothing for
//      pino's `redact` option to have to strip in practice.
//   2. `redact` is still configured, defense-in-depth, in case a future call
//      site accidentally logs a raw headers/body object.
//
// Never logged by default (Layer 4A spec §10): access/refresh tokens,
// passwords, OAuth credentials, raw health data, child health data, raw
// imported content, food photographs, AI prompt payloads containing
// sensitive profile information. This module cannot enforce the
// health-data/AI-payload rules structurally (they are not header/field
// names) — those are enforced by domain code never passing that data to the
// logger in the first place; see domain-level code review notes.

import pino from 'pino';

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  '*.authorization',
  '*.accessToken',
  '*.access_token',
  '*.refreshToken',
  '*.refresh_token',
  '*.token',
  '*.password',
  '*.jwt',
  '*.apiKey',
  '*.api_key',
  '*.secret',
];

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: REDACT_PATHS,
    censor: '[REDACTED]',
  },
  base: { service: 'recipebook-api' },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export type Logger = typeof logger;
