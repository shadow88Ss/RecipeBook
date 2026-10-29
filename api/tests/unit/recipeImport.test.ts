import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseIngredientAmount } from '../../src/domain/recipeImports/ingredientLine';
import { createPageFetcher, PageFetchError } from '../../src/domain/recipeImports/pageFetcher';
import { cleanText, extractRecipeFromHtml } from '../../src/domain/recipeImports/recipeJsonLd';
import { canonicalizeSourceUrl, isBlockedAddress } from '../../src/domain/recipeImports/sourceUrl';

describe('canonicalizeSourceUrl', () => {
  it('drops fragments, tracking parameters, default ports and trailing slashes, and sorts the rest', () => {
    const result = canonicalizeSourceUrl('HTTPS://Www.Example-Recipes.com:443/pasta/?utm_source=x&b=2&a=1&fbclid=z#comments');
    expect(result).toEqual({ ok: true, canonicalUrl: 'https://www.example-recipes.com/pasta?a=1&b=2', provider: 'web', host: 'www.example-recipes.com' });
  });

  it('gives the same key for links that differ only in tracking', () => {
    const a = canonicalizeSourceUrl('https://site.co/r/1?utm_medium=social');
    const b = canonicalizeSourceUrl('https://site.co/r/1/');
    expect(a.ok && b.ok && a.canonicalUrl === b.canonicalUrl).toBe(true);
  });

  it('detects social providers', () => {
    expect(canonicalizeSourceUrl('https://www.instagram.com/p/abc/?igsh=1')).toMatchObject({ provider: 'instagram', canonicalUrl: 'https://www.instagram.com/p/abc' });
    expect(canonicalizeSourceUrl('https://youtu.be/xyz')).toMatchObject({ provider: 'youtube' });
    expect(canonicalizeSourceUrl('https://vm.tiktok.com/abc')).toMatchObject({ provider: 'tiktok' });
  });

  it.each([
    ['ftp://example.com/x', 'unsupported_scheme'],
    ['file:///etc/passwd', 'unsupported_scheme'],
    ['javascript:alert(1)', 'unsupported_scheme'],
    ['https://user:pw@example.com/', 'credentials_not_allowed'],
    ['https://example.com:8443/', 'port_not_allowed'],
    ['http://127.0.0.1/', 'host_not_allowed'],
    ['http://2130706433/', 'host_not_allowed'],
    ['http://0x7f.1/', 'host_not_allowed'],
    ['http://[::1]/', 'host_not_allowed'],
    ['http://169.254.169.254/latest/meta-data', 'host_not_allowed'],
    ['http://localhost/', 'host_not_allowed'],
    ['http://intranet/', 'host_not_allowed'],
    ['http://printer.local/', 'host_not_allowed'],
    ['not a url', 'invalid_url'],
  ])('refuses %s', (input, reason) => {
    expect(canonicalizeSourceUrl(input)).toEqual({ ok: false, reason });
  });
});

describe('isBlockedAddress', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', '::', 'fc00::1', 'fd12::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '64:ff9b::a00:1', '2002:7f00:1::', 'ff02::1'])(
    'blocks %s',
    (address) => expect(isBlockedAddress(address)).toBe(true),
  );
  it.each(['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:4700:4700::1111'])('allows %s', (address) => expect(isBlockedAddress(address)).toBe(false));
});

describe('parseIngredientAmount', () => {
  it.each<[string, ReturnType<typeof parseIngredientAmount>]>([
    ['200g butter', { quantity: 200, unit: 'g' }],
    ['200 grams butter', { quantity: 200, unit: 'g' }],
    ['1.5 kg potatoes', { quantity: 1.5, unit: 'kg' }],
    ['1,5 l milk', { quantity: 1.5, unit: 'l' }],
    ['2 lbs chicken thighs', { quantity: 2, unit: 'lb' }],
    ['250 ml stock', { quantity: 250, unit: 'ml' }],
    ['2 eggs', { quantity: 2 }],
    ['3 cloves garlic, minced', { quantity: 3 }],
    ['½ onion', { quantity: 0.5 }],
    ['1 ½ kg flour', { quantity: 1.5, unit: 'kg' }],
    ['1 1/2 kg flour', { quantity: 1.5, unit: 'kg' }],
    ['1/3 lb cheese', { quantity: 0.3333, unit: 'lb' }],
    ['2 cups flour', { note: 'ambiguous_unit' }],
    ['1 tbsp. olive oil', { note: 'ambiguous_unit' }],
    ['2 fl oz cream', { note: 'ambiguous_unit' }],
    ['2-3 tomatoes', { note: 'range' }],
    ['2 to 3 tomatoes', { note: 'range' }],
    ['1 tomato', { quantity: 1 }],
    ['Salt to taste', {}],
    ['a pinch of salt', {}],
    ['2 (14 oz) cans tomatoes', { quantity: 2 }],
  ])('%s', (line, expected) => {
    expect(parseIngredientAmount(line)).toEqual(expected);
  });
});

function page(jsonLd: unknown, extra = ''): string {
  return `<!doctype html><html><head><title>x</title>${extra}<script type="application/ld+json">${JSON.stringify(jsonLd)}</script></head><body></body></html>`;
}

describe('extractRecipeFromHtml', () => {
  it('reads a Recipe inside @graph with HowToSteps, yield and image', () => {
    const html = page({
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'WebPage', name: 'Page' },
        {
          '@type': ['Recipe', 'NewsArticle'],
          name: 'Lemon &amp; Herb Chicken',
          description: '<p>Bright and <b>easy</b>.</p>',
          recipeYield: ['4', '4 servings'],
          image: [{ '@type': 'ImageObject', url: 'https://cdn.example.com/a.jpg' }],
          author: { '@type': 'Person', name: 'Sam Cook' },
          recipeIngredient: ['500 g chicken thighs', '2 tbsp olive oil', '1 lemon', ''],
          recipeInstructions: [
            { '@type': 'HowToSection', name: 'Prep', itemListElement: [{ '@type': 'HowToStep', text: 'Zest the lemon.' }] },
            { '@type': 'HowToStep', text: 'Roast for 30 minutes&nbsp;at 200&deg;C.' },
          ],
        },
      ],
    });
    const result = extractRecipeFromHtml(html);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe('success');
    expect(result.draft).toEqual({
      title: 'Lemon & Herb Chicken',
      description: 'Bright and easy .',
      servings: 4,
      yield_text: null,
      ingredients: [
        { text: '500 g chicken thighs', quantity: 500, unit: 'g' },
        { text: '2 tbsp olive oil', note: 'ambiguous_unit' },
        { text: '1 lemon', quantity: 1 },
      ],
      instructions: ['Zest the lemon.', 'Roast for 30 minutes at 200°C.'],
      image_url: 'https://cdn.example.com/a.jpg',
      author: 'Sam Cook',
      truncated: false,
    });
    expect(result.confidence).toBeGreaterThan(0.9);
  });

  it('splits a single instruction text into steps and keeps a non-serving yield as text', () => {
    const html = page([
      { '@type': 'Organization', name: 'Site' },
      { '@type': 'http://schema.org/Recipe', name: 'Cookies', recipeYield: 'Makes 24 cookies', recipeIngredient: ['2 cups flour'], recipeInstructions: '1. Mix.<br>2. Bake.' },
    ]);
    const result = extractRecipeFromHtml(html);
    expect(result).toMatchObject({ ok: true, status: 'partial_success', draft: { servings: null, yield_text: 'Makes 24 cookies', instructions: ['Mix.', 'Bake.'] } });
  });

  it('skips invalid JSON-LD blocks and finds the recipe in a later one', () => {
    const html = `<script type="application/ld+json">{ not json }</script>${page({ '@type': 'Recipe', name: 'Soup', recipeYield: 2, recipeIngredient: ['1 l water'] })}`;
    expect(extractRecipeFromHtml(html)).toMatchObject({ ok: true, draft: { title: 'Soup', servings: 2 } });
  });

  it('reports pages without a recipe or without ingredients', () => {
    expect(extractRecipeFromHtml('<html><body>Just a blog</body></html>')).toEqual({ ok: false, reason: 'no_recipe_found' });
    expect(extractRecipeFromHtml(page({ '@type': 'Article', name: 'x' }))).toEqual({ ok: false, reason: 'no_recipe_found' });
    expect(extractRecipeFromHtml(page({ '@type': 'Recipe', name: 'x', recipeIngredient: [] }))).toEqual({ ok: false, reason: 'no_ingredients' });
  });

  it('caps lists at the recipe limits and says so', () => {
    const lines = Array.from({ length: 130 }, (_, i) => `${i + 1} g item`);
    const result = extractRecipeFromHtml(page({ '@type': 'Recipe', name: 'Big', recipeYield: '10', recipeIngredient: lines, recipeInstructions: ['Go.'] }));
    expect(result).toMatchObject({ ok: true, status: 'partial_success', draft: { truncated: true } });
    if (result.ok) expect(result.draft.ingredients).toHaveLength(100);
  });

  it('ignores non-https images', () => {
    const result = extractRecipeFromHtml(page({ '@type': 'Recipe', name: 'x', image: 'http://insecure/a.jpg', recipeIngredient: ['1 egg'] }));
    expect(result).toMatchObject({ ok: true, draft: { image_url: null } });
  });
});

describe('cleanText', () => {
  it('strips tags, decodes (double-encoded) entities and collapses whitespace', () => {
    expect(cleanText('  Mac &amp;amp; cheese&#39;s <em>best</em>\n  ever ', false)).toBe("Mac & cheese's best ever");
  });
});

describe('createPageFetcher', () => {
  let server: Server;
  let port = 0;
  const loopbackAsPublic = (fakeAddress: string) => async () => [{ address: fakeAddress, family: 4 }];

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/recipe') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip' });
        res.end(gzipSync('<html>ok</html>'));
      } else if (req.url === '/json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      } else if (req.url === '/big') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('x'.repeat(5000));
      } else if (req.url === '/to-internal') {
        res.writeHead(302, { location: 'http://127.0.0.1/secret' });
        res.end();
      } else if (req.url === '/missing') {
        res.writeHead(404, { 'content-type': 'text/html' });
        res.end();
      } else {
        res.writeHead(503);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('refuses a public name that resolves to a private address', async () => {
    const fetcher = createPageFetcher({ resolve: loopbackAsPublic('127.0.0.1') });
    await expect(fetcher.fetchPage('http://recipes.example-site.com/recipe')).rejects.toMatchObject({ code: 'address_not_allowed' });
  });

  it('refuses a name with any private address among its answers', async () => {
    const fetcher = createPageFetcher({
      resolve: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.5', family: 4 },
      ],
    });
    await expect(fetcher.fetchPage('https://recipes.example-site.com/')).rejects.toMatchObject({ code: 'address_not_allowed' });
  });

  it('refuses URLs the canonicalizer refuses, before any DNS lookup', async () => {
    let looked = false;
    const fetcher = createPageFetcher({
      resolve: async () => {
        looked = true;
        return [];
      },
    });
    await expect(fetcher.fetchPage(`http://127.0.0.1:${port}/recipe`)).rejects.toBeInstanceOf(PageFetchError);
    expect(looked).toBe(false);
  });

  it('reports DNS failures as retryable', async () => {
    const fetcher = createPageFetcher({
      resolve: async () => {
        throw new Error('ENOTFOUND');
      },
    });
    await expect(fetcher.fetchPage('https://nowhere.example-site.com/')).rejects.toMatchObject({ code: 'dns_failed', retryable: true });
  });

  describe('against a local server', () => {
    const fetcher = () =>
      createPageFetcher({ resolve: loopbackAsPublic('127.0.0.1'), maxBytes: 1000, testing: { allowAddress: (a) => a === '127.0.0.1', port } });

    it('reads and decompresses an HTML page', async () => {
      await expect(fetcher().fetchPage('http://site.example-recipes.com/recipe')).resolves.toMatchObject({ status: 200, html: '<html>ok</html>' });
    });
    it('refuses non-HTML content', async () => {
      await expect(fetcher().fetchPage('http://site.example-recipes.com/json')).rejects.toMatchObject({ code: 'not_html' });
    });
    it('stops reading past the size cap', async () => {
      await expect(fetcher().fetchPage('http://site.example-recipes.com/big')).rejects.toMatchObject({ code: 'too_large' });
    });
    it('re-validates every redirect target', async () => {
      await expect(fetcher().fetchPage('http://site.example-recipes.com/to-internal')).rejects.toMatchObject({ code: 'url_not_allowed' });
    });
    it('maps HTTP errors, marking 5xx as retryable', async () => {
      await expect(fetcher().fetchPage('http://site.example-recipes.com/missing')).rejects.toMatchObject({ code: 'http_error', httpStatus: 404, retryable: false });
      await expect(fetcher().fetchPage('http://site.example-recipes.com/down')).rejects.toMatchObject({ code: 'http_error', httpStatus: 503, retryable: true });
    });
  });

  it('never connects to loopback without the test seam, even when DNS is spoofed', async () => {
    const fetcher = createPageFetcher({ resolve: loopbackAsPublic('127.0.0.1') });
    await expect(fetcher.fetchPage('http://site.example-recipes.com/recipe')).rejects.toMatchObject({ code: 'address_not_allowed' });
  });
});
