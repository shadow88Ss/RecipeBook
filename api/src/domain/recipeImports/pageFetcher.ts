// Layer 13A — fetching a recipe web page from the server, safely.
//
// The server fetches a URL the user typed, so every request is treated as
// a server-side request forgery risk (33_Security_and_Privacy.md, Master
// §3.5 "externally supplied"):
//   - only URLs accepted by canonicalizeSourceUrl() are requested;
//   - DNS is resolved here and EVERY resolved address is checked with
//     isBlockedAddress() before connecting; the socket then connects to the
//     checked address itself, so a second DNS answer (rebinding) can never
//     redirect the connection to an internal address;
//   - redirects are followed manually, at most MAX_REDIRECTS, and each hop
//     is validated again from scratch;
//   - a hard total timeout and a cap on the decoded body size;
//   - only HTML responses are read; no cookies are sent or kept.
//
// The fetcher returns the page text to the extractor and nothing else. It
// never stores the page (recipeImport.service.ts decides what is kept).

import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { Readable } from 'node:stream';
import { canonicalizeSourceUrl, isBlockedAddress } from './sourceUrl';

export const FETCH_TIMEOUT_MS = 10_000;
export const MAX_PAGE_BYTES = 3 * 1024 * 1024;
export const MAX_REDIRECTS = 5;
export const USER_AGENT = 'RecipeBookImporter/1.0 (+recipe import on behalf of a signed-in user)';

export type FetchFailureCode =
  | 'url_not_allowed'
  | 'address_not_allowed'
  | 'dns_failed'
  | 'timeout'
  | 'too_many_redirects'
  | 'http_error'
  | 'not_html'
  | 'too_large'
  | 'network_error';

export class PageFetchError extends Error {
  constructor(
    readonly code: FetchFailureCode,
    /** True when the same request may succeed later (timeouts, 5xx, 429). */
    readonly retryable: boolean,
    readonly httpStatus?: number,
  ) {
    super(`Page fetch failed: ${code}${httpStatus ? ` (${httpStatus})` : ''}`);
    this.name = 'PageFetchError';
  }
}

export interface FetchedPage {
  /** The URL the content was finally served from, after redirects. */
  finalUrl: string;
  status: number;
  contentType: string;
  html: string;
}

export interface PageFetcher {
  fetchPage(url: string): Promise<FetchedPage>;
}

type Resolver = (host: string) => Promise<LookupAddress[]>;

export interface PageFetcherOptions {
  /** Test seam: DNS resolution. Defaults to the system resolver. */
  resolve?: Resolver;
  timeoutMs?: number;
  maxBytes?: number;
  /** Test seam only (never set by app.ts): lets unit tests reach a
   * loopback test server on its ephemeral port. */
  testing?: { allowAddress: (address: string) => boolean; port: number };
}

const systemResolve: Resolver = (host) =>
  new Promise((resolve, reject) => {
    dnsLookup(host, { all: true, verbatim: true }, (err, addresses) => (err ? reject(err) : resolve(addresses)));
  });

export function createPageFetcher(options: PageFetcherOptions = {}): PageFetcher {
  const resolve = options.resolve ?? systemResolve;
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_PAGE_BYTES;
  const blocked = options.testing ? (a: string) => !options.testing?.allowAddress(a) : isBlockedAddress;

  return {
    async fetchPage(startUrl: string): Promise<FetchedPage> {
      const deadline = Date.now() + timeoutMs;
      let current = startUrl;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        const checked = canonicalizeSourceUrl(current);
        if (!checked.ok) throw new PageFetchError('url_not_allowed', false);
        // The original URL (not the canonical one) is requested: tracking
        // parameters are dropped only from the dedup key, and some sites
        // need the exact link.
        const target = new URL(current);
        const address = await resolveSafely(resolve, target.hostname, deadline, blocked);
        const response = await requestOnce(target, address, deadline, options.testing?.port);
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          current = new URL(response.headers.location, target).toString();
          continue;
        }
        if (status < 200 || status >= 300) {
          response.resume();
          throw new PageFetchError('http_error', status === 408 || status === 429 || status >= 500, status);
        }
        const contentType = String(response.headers['content-type'] ?? '').toLowerCase();
        if (!/^(text\/html|application\/xhtml\+xml)\b/.test(contentType)) {
          response.resume();
          throw new PageFetchError('not_html', false, status);
        }
        const body = await readBody(response, maxBytes, deadline);
        return { finalUrl: target.toString(), status, contentType, html: decodeBody(body, contentType) };
      }
      throw new PageFetchError('too_many_redirects', false);
    },
  };
}

async function resolveSafely(resolve: Resolver, host: string, deadline: number, blocked: (address: string) => boolean): Promise<LookupAddress> {
  let addresses: LookupAddress[];
  try {
    addresses = await withDeadline(resolve(host), deadline);
  } catch (err) {
    if (err instanceof PageFetchError) throw err;
    throw new PageFetchError('dns_failed', true);
  }
  if (addresses.length === 0) throw new PageFetchError('dns_failed', true);
  // Any blocked answer refuses the whole host: a name that mixes public and
  // private addresses is not something we connect to.
  if (addresses.some((a) => blocked(a.address))) throw new PageFetchError('address_not_allowed', false);
  const first = addresses[0];
  if (!first) throw new PageFetchError('dns_failed', true);
  return first;
}

function requestOnce(target: URL, address: LookupAddress, deadline: number, portOverride?: number): Promise<IncomingMessage> {
  // Pins the connection to the address checked above.
  const pinnedLookup: LookupFunction = (_host, opts, callback) => {
    if ((opts as { all?: boolean }).all) {
      (callback as unknown as (err: null, addresses: LookupAddress[]) => void)(null, [address]);
    } else {
      callback(null, address.address, address.family);
    }
  };
  const options: RequestOptions = {
    method: 'GET',
    ...(portOverride !== undefined ? { port: portOverride } : {}),
    lookup: pinnedLookup,
    headers: {
      'user-agent': USER_AGENT,
      accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
      'accept-encoding': 'gzip, deflate, br',
      'accept-language': 'en;q=0.9, *;q=0.5',
    },
    timeout: Math.max(deadline - Date.now(), 1),
  };
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send(target, options, resolve);
    const timer = setTimeout(() => req.destroy(new PageFetchError('timeout', true)), Math.max(deadline - Date.now(), 1));
    req.on('response', () => clearTimeout(timer));
    req.on('timeout', () => req.destroy(new PageFetchError('timeout', true)));
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err instanceof PageFetchError ? err : new PageFetchError('network_error', true));
    });
    req.end();
  });
}

function readBody(response: IncomingMessage, maxBytes: number, deadline: number): Promise<Buffer> {
  const encoding = String(response.headers['content-encoding'] ?? '').toLowerCase().trim();
  let stream: Readable = response;
  if (encoding === 'gzip' || encoding === 'x-gzip') stream = response.pipe(createGunzip());
  else if (encoding === 'deflate') stream = response.pipe(createInflate());
  else if (encoding === 'br') stream = response.pipe(createBrotliDecompress());

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const fail = (err: PageFetchError) => {
      clearTimeout(timer);
      response.destroy();
      stream.destroy();
      reject(err);
    };
    const timer = setTimeout(() => fail(new PageFetchError('timeout', true)), Math.max(deadline - Date.now(), 1));
    stream.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) return fail(new PageFetchError('too_large', false));
      chunks.push(chunk);
    });
    stream.on('end', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });
    stream.on('error', () => fail(new PageFetchError('network_error', true)));
  });
}

function decodeBody(body: Buffer, contentType: string): string {
  const declared = /charset=["']?([\w-]+)/.exec(contentType)?.[1];
  try {
    return new TextDecoder(declared ?? 'utf-8').decode(body);
  } catch {
    return new TextDecoder('utf-8').decode(body);
  }
}

function withDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new PageFetchError('timeout', true)), Math.max(deadline - Date.now(), 1));
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
