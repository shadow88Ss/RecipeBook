// Layer 13A — reading a recipe from the structured data a web page
// publishes (schema.org/Recipe in JSON-LD).
//
// Most recipe sites embed this for search engines, so it is the most
// reliable source on the page and needs no AI. The extractor is
// deterministic: the same page always gives the same draft. Nothing is
// invented: a field the page does not state is left empty, and every
// ingredient keeps the exact line the page published.
//
// Pages without schema.org/Recipe data are reported as `no_recipe_found`;
// reading free text (captions, blog prose) is AI extraction work for a later
// layer (Master §3: Claude interprets, deterministic services calculate).

import { parseIngredientAmount, parseNumber, type ParsedIngredientAmount } from './ingredientLine';

export const EXTRACTION_METHOD = 'schema_org_json_ld';
/** Bumped whenever the extractor's output for the same page can change. */
export const EXTRACTOR_VERSION = 'recipe-json-ld-v1';

// Limits mirror recipe.schemas.ts so a draft can always be saved as-is.
const MAX_TITLE = 200;
const MAX_DESCRIPTION = 5000;
const MAX_INGREDIENT_TEXT = 500;
const MAX_INSTRUCTION_TEXT = 5000;
const MAX_ITEMS = 100;
const MAX_SERVINGS = 1000;
const MAX_JSON_LD_BLOCKS = 50;
const MAX_JSON_LD_BLOCK_BYTES = 1_000_000;

export interface DraftIngredient extends ParsedIngredientAmount {
  text: string;
}

export interface RecipeDraft {
  title: string;
  description: string | null;
  servings: number | null;
  /** The page's yield text when it could not be read as a serving count. */
  yield_text: string | null;
  ingredients: DraftIngredient[];
  instructions: string[];
  image_url: string | null;
  author: string | null;
  /** Lists longer than the recipe limits were cut. */
  truncated: boolean;
}

export type ExtractionResult =
  | { ok: true; draft: RecipeDraft; confidence: number; status: 'success' | 'partial_success'; json_ld: unknown }
  | { ok: false; reason: 'no_recipe_found' | 'no_ingredients' };

export function extractRecipeFromHtml(html: string): ExtractionResult {
  const recipe = findRecipeNode(readJsonLdBlocks(html));
  if (!recipe) return { ok: false, reason: 'no_recipe_found' };

  const rawIngredients = asArray(recipe.recipeIngredient ?? recipe.ingredients).map(textOf).filter(nonEmpty);
  if (rawIngredients.length === 0) return { ok: false, reason: 'no_ingredients' };

  const instructions = readInstructions(recipe.recipeInstructions);
  const servings = readServings(recipe.recipeYield);
  const truncated = rawIngredients.length > MAX_ITEMS || instructions.length > MAX_ITEMS;

  const ingredients = rawIngredients.slice(0, MAX_ITEMS).map((line): DraftIngredient => {
    const text = clip(line, MAX_INGREDIENT_TEXT);
    return { text, ...parseIngredientAmount(text) };
  });

  const title = clip(textOf(recipe.name) || textOf(recipe.headline), MAX_TITLE);
  const draft: RecipeDraft = {
    title: title || 'Imported recipe',
    description: clip(textOf(recipe.description), MAX_DESCRIPTION) || null,
    servings: servings.value,
    yield_text: servings.value === null ? servings.text : null,
    ingredients,
    instructions: instructions.slice(0, MAX_ITEMS).map((s) => clip(s, MAX_INSTRUCTION_TEXT)),
    image_url: readImageUrl(recipe.image),
    author: clip(readAuthor(recipe.author), MAX_TITLE) || null,
    truncated,
  };

  // Confidence is how complete the page's own data is, not a guess about
  // correctness: title, yield, steps and readable amounts each count.
  const amountShare = ingredients.filter((i) => i.quantity !== undefined).length / ingredients.length;
  const score = 0.4 + (title ? 0.15 : 0) + (draft.servings !== null ? 0.15 : 0) + (draft.instructions.length > 0 ? 0.15 : 0) + 0.15 * amountShare;
  const confidence = Math.round(Math.min(score, 1) * 100) / 100;
  const complete = Boolean(title) && draft.servings !== null && draft.instructions.length > 0 && !truncated;
  return { ok: true, draft, confidence, status: complete ? 'success' : 'partial_success', json_ld: recipe };
}

type JsonObject = Record<string, unknown>;

/** Every parseable <script type="application/ld+json"> block. A block that
 * is not valid JSON is skipped, never "repaired". */
export function readJsonLdBlocks(html: string): unknown[] {
  const blocks: unknown[] = [];
  const pattern = /<script\b[^>]*\btype\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script\s*>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null && blocks.length < MAX_JSON_LD_BLOCKS) {
    const body = (match[1] ?? '').trim().replace(/^<!--/, '').replace(/-->$/, '').replace(/^\s*\/\/\s*<!\[CDATA\[/, '').replace(/\/\/\s*\]\]>\s*$/, '');
    if (body.length === 0 || body.length > MAX_JSON_LD_BLOCK_BYTES) continue;
    try {
      blocks.push(JSON.parse(body));
    } catch {
      // Not valid JSON: skipped.
    }
  }
  return blocks;
}

/** Depth-first search through arrays, @graph, mainEntity and
 * mainEntityOfPage for the first node typed Recipe. */
export function findRecipeNode(blocks: unknown[]): JsonObject | null {
  const seen = new Set<unknown>();
  const stack: unknown[] = [...blocks].reverse();
  let visited = 0;
  while (stack.length > 0 && visited < 10_000) {
    const node = stack.pop();
    visited += 1;
    if (node === null || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i -= 1) stack.push(node[i]);
      continue;
    }
    const obj = node as JsonObject;
    if (isRecipeType(obj['@type'])) return obj;
    for (const key of ['mainEntity', 'mainEntityOfPage', '@graph', 'itemListElement', 'item']) {
      if (obj[key] !== undefined) stack.push(obj[key]);
    }
  }
  return null;
}

function isRecipeType(type: unknown): boolean {
  const types = asArray(type).filter((t): t is string => typeof t === 'string');
  return types.some((t) => t.replace(/^https?:\/\/schema\.org\//i, '').toLowerCase() === 'recipe');
}

function readInstructions(value: unknown): string[] {
  const steps: string[] = [];
  const visit = (node: unknown, depth: number) => {
    if (depth > 6 || steps.length > MAX_ITEMS) return;
    if (typeof node === 'string') {
      // A single text block: one step per line or numbered paragraph.
      for (const line of cleanText(node, true).split(/\n+/)) {
        const step = line.replace(/^\s*(?:step\s*)?\d+[.):]\s*/i, '').trim();
        if (step) steps.push(step);
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((n) => visit(n, depth + 1));
      return;
    }
    if (node && typeof node === 'object') {
      const obj = node as JsonObject;
      // HowToSection: its steps, in order. HowToStep: its text (or name).
      if (obj.itemListElement !== undefined) return visit(obj.itemListElement, depth + 1);
      const text = textOf(obj.text) || textOf(obj.name);
      if (text) steps.push(text);
    }
  };
  visit(value, 0);
  return steps;
}

/** recipeYield is free-form: 4, "4", "4 servings", ["4", "4 servings"],
 * "Makes 12 cookies". A count of servings is only taken when stated as a
 * plain number or "N servings/portions/people"; "12 cookies" is a yield,
 * not servings, and is kept as text for the user to confirm. */
function readServings(value: unknown): { value: number | null; text: string | null } {
  const candidates = asArray(value).map((v) => (typeof v === 'number' ? String(v) : textOf(v))).filter(nonEmpty);
  for (const candidate of candidates) {
    const t = candidate.toLowerCase().trim();
    const plain = parseNumber(t);
    const stated = /^(?:serves|servings?|portions?|yield|makes)?\s*:?\s*(\d+(?:[.,]\d+)?)\s*(?:servings?|portions?|people|persons?|serves)?$/.exec(t);
    const n = plain ?? (stated?.[1] ? Number(stated[1].replace(',', '.')) : null);
    if (n !== null && n > 0 && n <= MAX_SERVINGS) return { value: Math.round(n * 100) / 100, text: candidate };
  }
  return { value: null, text: candidates[0] ? clip(candidates[0], MAX_TITLE) : null };
}

function readImageUrl(value: unknown): string | null {
  for (const item of asArray(value)) {
    const url = typeof item === 'string' ? item : item && typeof item === 'object' ? (item as JsonObject).url : undefined;
    if (typeof url === 'string' && /^https:\/\//i.test(url) && url.length <= 2048) return url;
  }
  return null;
}

function readAuthor(value: unknown): string {
  for (const item of asArray(value)) {
    const name = typeof item === 'string' ? item : item && typeof item === 'object' ? (item as JsonObject).name : undefined;
    const text = textOf(name);
    if (text) return text;
  }
  return '';
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return cleanText(value, false);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function nonEmpty(value: string): boolean {
  return value.length > 0;
}

function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1).trimEnd()}…`;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
  frac12: '½', frac14: '¼', frac34: '¾', deg: '°', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', eacute: 'é', egrave: 'è',
};

/** JSON-LD text often carries HTML tags and entities. Tags are removed (a
 * <br>/<p>/<li> becomes a line break when lines matter), entities decoded,
 * whitespace collapsed. */
export function cleanText(value: string, keepLines: boolean): string {
  let text = value;
  if (keepLines) text = text.replace(/<\s*(?:br|\/p|\/li|\/div)\b[^>]*>/gi, '\n');
  text = text.replace(/<[^>]*>/g, ' ');
  // Entities are decoded twice because some sites double-encode (&amp;#39;).
  for (let i = 0; i < 2; i += 1) {
    text = text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (whole, entity: string) => {
      if (entity[0] === '#') {
        const code = entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
      }
      return NAMED_ENTITIES[entity.toLowerCase()] ?? whole;
    });
  }
  if (keepLines) {
    return text
      .split('\n')
      .map((l) => l.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join('\n');
  }
  return text.replace(/\s+/g, ' ').trim();
}
