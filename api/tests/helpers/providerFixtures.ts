// Layer 11D — deterministic HTTP fixtures standing in for FatSecret and
// Open Food Facts. Response shapes follow the providers' published
// documentation (FatSecret food.get v4 / barcode find-by-id / foods.search,
// Open Food Facts API v2 product). No test touches the network.

export const FS_CLIENT_ID = 'fs_client_id_example_1234';
export const FS_CLIENT_SECRET = 'fs_client_secret_SUPERSECRET_5678';
export const FS_ACCESS_TOKEN_PREFIX = 'fs_access_token_';

export type Behaviour =
  | 'ok'
  | 'timeout'
  | 'http_500'
  | 'http_429'
  | 'network_error'
  | 'invalid_json'
  | 'malformed'
  | 'rate_limit_code'
  | 'bad_credentials'
  | 'invalid_ip'
  | 'missing_scope'
  | 'leaky_error';

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

/** A FatSecret branded food with one serving: fat stated as 0 (known zero),
 * fiber omitted (missing), a mapped and several unmapped nutrients. */
export const FS_YOGURT = {
  food_id: '4384',
  food_name: 'Plain Greek Yogurt',
  brand_name: 'Example Dairy',
  food_type: 'Brand',
  food_url: 'https://www.fatsecret.com/calories-nutrition/example-dairy/plain-greek-yogurt',
  servings: {
    serving: {
      serving_id: '17120',
      serving_description: '1 container (170 g)',
      serving_url: 'https://www.fatsecret.com/x',
      metric_serving_amount: '170.000',
      metric_serving_unit: 'g',
      number_of_units: '1.000',
      measurement_description: 'container',
      calories: '100',
      carbohydrate: '6.00',
      protein: '17.00',
      fat: '0',
      saturated_fat: '0',
      sodium: '65',
      sugar: '6.00',
      vitamin_c: '0',
      calcium: '190',
    },
  },
};

/** A FatSecret generic food with two servings. */
export const FS_OATS = {
  food_id: '38821',
  food_name: 'Oats',
  food_type: 'Generic',
  food_url: 'https://www.fatsecret.com/calories-nutrition/generic/oats',
  servings: {
    serving: [
      { serving_id: '1', serving_description: '1 cup', metric_serving_amount: '81.000', metric_serving_unit: 'g', number_of_units: '1.000', measurement_description: 'cup', calories: '307', carbohydrate: '54.84', protein: '10.69', fat: '5.28', fiber: '8.2' },
      { serving_id: '2', serving_description: '100 g', metric_serving_amount: '100.000', metric_serving_unit: 'g', number_of_units: '100.000', measurement_description: 'g', calories: '379', carbohydrate: '67.70', protein: '13.20', fat: '6.52', fiber: '10.1', is_default: '1' },
    ],
  },
};

/** Open Food Facts product: kcal stated, carbohydrate (EU) and sodium present
 * but unmappable, fiber stated as 0, protein omitted (missing). */
export const OFF_SPREAD = {
  code: '3017624010701',
  product_name: 'Hazelnut Spread',
  brands: 'Example Foods, Example Brand Two',
  quantity: '400 g',
  product_quantity: 400,
  product_quantity_unit: 'g',
  serving_size: '15 g',
  serving_quantity: 15,
  serving_quantity_unit: 'g',
  nutrition_data_per: '100g',
  countries_tags: ['en:france', 'en:germany'],
  ingredients_text: 'Sugar, palm oil, hazelnuts 13%, skimmed milk powder 8.7%, fat-reduced cocoa 7.4%',
  nutriments: {
    'energy-kcal_100g': 539,
    'energy-kcal_unit': 'kcal',
    'energy-kj_100g': 2252,
    energy_100g: 2252,
    fat_100g: 30.9,
    'saturated-fat_100g': 10.6,
    carbohydrates_100g: 57.5,
    sugars_100g: 56.3,
    fiber_100g: 0,
    salt_100g: 0.107,
    sodium_100g: 0.0428,
    calcium_100g: 0.108,
    'vitamin-a_100g': 0.0001,
  },
};

/** An Open Food Facts product that states energy only in kJ. */
export const OFF_KJ_ONLY = {
  code: '5000112637922',
  product_name: 'Cola Drink',
  brands: 'Example Cola',
  quantity: '330 ml',
  product_quantity: '330',
  product_quantity_unit: 'ml',
  nutriments: { 'energy-kj_100g': 180, energy_100g: 180, carbohydrates_100g: 10.6, proteins_100g: 0 },
};

export class FakeProviderHttp {
  calls: RecordedCall[] = [];
  fatsecret: Behaviour = 'ok';
  off: Behaviour = 'ok';
  /** Makes the next N FatSecret API calls answer "invalid token" (code 13). */
  expireTokenOnce = 0;
  tokensIssued = 0;
  tokenLifetimeSeconds = 86_400;
  fsBarcodes = new Map<string, string>(); // GTIN-13 -> food_id
  fsFoods = new Map<string, unknown>();
  offProducts = new Map<string, unknown>();

  reset(): void {
    this.calls = [];
    this.fatsecret = 'ok';
    this.off = 'ok';
    this.expireTokenOnce = 0;
  }

  callsTo(host: 'fatsecret' | 'fatsecret_token' | 'off'): RecordedCall[] {
    return this.calls.filter((c) =>
      host === 'off' ? c.url.includes('openfoodfacts') : host === 'fatsecret_token' ? c.url.startsWith('https://oauth.fatsecret.com') : c.url.startsWith('https://platform.fatsecret.com'),
    );
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    this.calls.push({ url, method: init?.method ?? 'GET', headers, body: typeof init?.body === 'string' ? init.body : null });
    const signal = init?.signal ?? undefined;
    const provider = url.includes('openfoodfacts') ? this.off : this.fatsecret;
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

    switch (provider) {
      case 'timeout':
        return new Promise<Response>((_, reject) => {
          signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        });
      case 'http_500':
        return new Response('<html>upstream error</html>', { status: 500 });
      case 'http_429':
        return new Response('slow down', { status: 429, headers: { 'retry-after': '120' } });
      case 'network_error':
        throw new TypeError('fetch failed');
      case 'invalid_json':
        return new Response('<html>not json</html>', { status: 200 });
      default:
        break;
    }

    if (url.startsWith('https://oauth.fatsecret.com/connect/token')) {
      if (provider === 'bad_credentials') return json({ error: 'invalid_client' }, 400);
      const expected = `Basic ${Buffer.from(`${FS_CLIENT_ID}:${FS_CLIENT_SECRET}`).toString('base64')}`;
      if (headers.authorization !== expected) return json({ error: 'invalid_client' }, 400);
      this.tokensIssued += 1;
      return json({ access_token: `${FS_ACCESS_TOKEN_PREFIX}${this.tokensIssued}`, expires_in: this.tokenLifetimeSeconds, token_type: 'Bearer', scope: 'basic barcode' });
    }

    if (url.startsWith('https://platform.fatsecret.com/rest/')) {
      if (!headers.authorization?.startsWith(`Bearer ${FS_ACCESS_TOKEN_PREFIX}`)) return json({ error: { code: 13, message: 'Invalid token' } });
      if (this.expireTokenOnce > 0) {
        this.expireTokenOnce -= 1;
        return json({ error: { code: 13, message: 'Invalid token' } });
      }
      if (provider === 'rate_limit_code') return json({ error: { code: 12, message: 'User is performing too many actions' } });
      if (provider === 'invalid_ip') return json({ error: { code: 21, message: 'Invalid IP address detected: 10.0.0.1' } });
      if (provider === 'missing_scope') return json({ error: { code: 14, message: 'Missing scope: barcode' } });
      if (provider === 'leaky_error') return json({ error: { code: 1, message: `An unknown error occurred: secret=${FS_CLIENT_SECRET}` } });
      const u = new URL(url);
      if (u.pathname === '/rest/food/barcode/find-by-id/v1') {
        if (provider === 'malformed') return json({ food_id: { value: 'not-a-number' } });
        const id = this.fsBarcodes.get(u.searchParams.get('barcode') ?? '') ?? '0';
        return json({ food_id: { value: id } });
      }
      if (u.pathname === '/rest/food/v4') {
        if (provider === 'malformed') return json({ food: { food_name: 'no id' } });
        const food = this.fsFoods.get(u.searchParams.get('food_id') ?? '');
        return food ? json({ food }) : json({ error: { code: 106, message: 'Invalid ID' } });
      }
      if (u.pathname === '/rest/foods/search/v1') {
        if (provider === 'malformed') return json({ foods: 'nope' });
        const q = (u.searchParams.get('search_expression') ?? '').toLowerCase();
        const foods = [...this.fsFoods.values()].filter((f) => String((f as { food_name: string }).food_name).toLowerCase().includes(q));
        if (!foods.length) return json({ foods: { max_results: '20', page_number: '0', total_results: '0' } });
        const listed = foods.map((f) => {
          const { servings: _servings, ...rest } = f as Record<string, unknown>;
          return { ...rest, food_description: 'Per 100g - Calories: 1kcal | Fat: 0g | Carbs: 0g | Protein: 0g' };
        });
        return json({ foods: { food: listed.length === 1 ? listed[0] : listed, max_results: '20', page_number: '0', total_results: String(listed.length) } });
      }
      return json({ error: { code: 23, message: 'Api not found' } });
    }

    if (url.includes('openfoodfacts')) {
      const u = new URL(url);
      const match = /^\/api\/v2\/product\/([0-9]+)$/.exec(u.pathname);
      if (!match) return json({ status: 0, status_verbose: 'no route' }, 404);
      if (provider === 'malformed') return json({ status: 1, product: 'not an object' });
      const product = this.offProducts.get(match[1] as string);
      return product ? json({ code: match[1], status: 1, status_verbose: 'product found', product }) : json({ code: match[1], status: 0, status_verbose: 'product not found' }, 404);
    }
    return json({}, 404);
  };
}
