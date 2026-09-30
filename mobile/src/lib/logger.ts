// Layer 12A §36–38 — local development logging only.
//
// No analytics or crash-reporting SDK is used. Logs go to the Metro console in
// development builds and are dropped in release builds. Context values whose
// key looks sensitive are redacted, and callers pass ids/kinds — never tokens,
// passwords, secrets or nutrition payloads.

const SENSITIVE_KEY = /token|password|secret|authorization|apikey|api_key|session|cookie|email/i;

export type LogContext = Record<string, string | number | boolean | null | undefined>;

export function redact(context: LogContext = {}): LogContext {
  const out: LogContext = {};
  for (const [key, value] of Object.entries(context)) {
    out[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : value;
  }
  return out;
}

const enabled = typeof __DEV__ !== 'undefined' ? __DEV__ : false;

export const logger = {
  info(message: string, context?: LogContext) {
    if (enabled) console.info(`[app] ${message}`, redact(context));
  },
  warn(message: string, context?: LogContext) {
    if (enabled) console.warn(`[app] ${message}`, redact(context));
  },
};
