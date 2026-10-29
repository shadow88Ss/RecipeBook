// Layer 13A — recipe import source URLs: validation, canonicalization and
// provider detection.
//
// The canonical URL is the deduplication key for UrlSource
// (29_Data_Model.md §7, 30_API.md §7): two links that differ only in a
// fragment, tracking parameters, letter case of the host, a default port or
// a trailing slash resolve to the same source. Everything else in the query
// string is kept and sorted, because some recipe sites route on it.
//
// Only http/https on the default ports, without credentials, to a public
// DNS name are accepted. IP literals and single-label/internal names are
// refused here; resolved addresses are checked again at connect time
// (pageFetcher.ts), so a public name that resolves to a private address is
// refused too.

import { isIP } from 'node:net';

export type SourceProvider = 'instagram' | 'tiktok' | 'youtube' | 'web';

export const MAX_SOURCE_URL_LENGTH = 2048;

export type SourceUrlResult =
  | { ok: true; canonicalUrl: string; provider: SourceProvider; host: string }
  | { ok: false; reason: SourceUrlRejection };

export type SourceUrlRejection =
  | 'invalid_url'
  | 'unsupported_scheme'
  | 'credentials_not_allowed'
  | 'port_not_allowed'
  | 'host_not_allowed';

/** Query parameters that only track the click, never select content. */
const TRACKING_PARAMS = new Set(['fbclid', 'gclid', 'dclid', 'msclkid', 'mc_cid', 'mc_eid', 'igshid', 'igsh', 'si', '_ga', 'ref_src']);
const TRACKING_PREFIXES = ['utm_'];

const BLOCKED_SUFFIXES = ['.local', '.localhost', '.internal', '.lan', '.home', '.corp', '.intranet', '.test', '.invalid', '.example'];

const PROVIDER_HOSTS: Array<{ provider: SourceProvider; hosts: string[] }> = [
  { provider: 'instagram', hosts: ['instagram.com', 'instagr.am'] },
  { provider: 'tiktok', hosts: ['tiktok.com'] },
  { provider: 'youtube', hosts: ['youtube.com', 'youtu.be'] },
];

export function detectProvider(host: string): SourceProvider {
  for (const entry of PROVIDER_HOSTS) {
    if (entry.hosts.some((h) => host === h || host.endsWith(`.${h}`))) return entry.provider;
  }
  return 'web';
}

export function canonicalizeSourceUrl(input: string): SourceUrlResult {
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_SOURCE_URL_LENGTH) return { ok: false, reason: 'invalid_url' };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, reason: 'unsupported_scheme' };
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'credentials_not_allowed' };
  // URL already drops the scheme's default port, so any port left is explicit.
  if (url.port !== '') return { ok: false, reason: 'port_not_allowed' };

  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!isPublicHostName(host)) return { ok: false, reason: 'host_not_allowed' };

  const params = [...url.searchParams.entries()]
    .filter(([key]) => !TRACKING_PARAMS.has(key.toLowerCase()) && !TRACKING_PREFIXES.some((p) => key.toLowerCase().startsWith(p)))
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : av > bv ? 1 : 0) : a < b ? -1 : 1));
  const query = new URLSearchParams(params).toString();
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : '/';
  // A www. prefix is kept: it is a different host as far as DNS and the
  // site are concerned, and stripping it would be a guess.
  const canonicalUrl = `${url.protocol}//${host}${path}${query ? `?${query}` : ''}`;
  return { ok: true, canonicalUrl, provider: detectProvider(host), host };
}

/** A DNS name with at least two labels that is not an IP literal and not a
 * reserved/internal suffix. */
export function isPublicHostName(host: string): boolean {
  if (host.length === 0 || host.length > 253) return false;
  if (host.startsWith('[') || isIP(host) !== 0) return false;
  // Hex/octal/decimal IPv4 forms ("0x7f.1", "2130706433") are normalized
  // to dotted IPv4 by URL, so they are caught by isIP above.
  const labels = host.split('.');
  if (labels.length < 2) return false;
  if (!labels.every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) return false;
  if (/^[0-9]+$/.test(labels[labels.length - 1] ?? '')) return false;
  if (host === 'localhost' || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) return false;
  return true;
}

/** True for an address that must never be reached from the server:
 * loopback, private, link-local (incl. cloud metadata), CGNAT, multicast,
 * reserved, unspecified, and the IPv6 equivalents / IPv4-mapped forms. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isBlockedIPv4(address);
  if (family === 6) return isBlockedIPv6(address);
  return true;
}

function isBlockedIPv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  const [a = 0, b = 0, c = 0] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 169 && b === 254) return true; // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // IETF, TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return true; // 6to4 relay
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

function isBlockedIPv6(address: string): boolean {
  const lower = address.toLowerCase();
  const mapped = /^(?:0{0,4}:){0,5}(?:0{0,4}:)?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower) ?? /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped?.[1]) return isBlockedIPv4(mapped[1]);
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hexMapped?.[1] && hexMapped[2]) {
    const hi = parseInt(hexMapped[1], 16);
    const lo = parseInt(hexMapped[2], 16);
    return isBlockedIPv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  if (lower === '::' || lower === '::1') return true;
  const first = parseInt(lower.split(':')[0] || '0', 16);
  if ((first & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((first & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((first & 0xff00) === 0xff00) return true; // multicast
  if (first === 0x2001 && parseInt(lower.split(':')[1] || '0', 16) === 0x0db8) return true; // documentation
  if (first === 0x0064 && lower.startsWith('64:ff9b:')) return true; // NAT64 can reach IPv4 internals
  if (first === 0x2002) return true; // 6to4 embeds arbitrary IPv4
  if (first === 0) return true; // ::/8 reserved, IPv4-compatible
  return false;
}
