// Layer 13B — choosing the Food for an ingredient line.
//
// Pure: no I/O. foodSuggestion.ts gathers candidates through the normal
// search_foods() (as the caller) and this module ranks them by what the line
// actually says, instead of taking the search's first row:
//
//   - every food word of the line must appear in the Food's name
//     ("olive oil" -> "Oil, olive, ..."; never "Oil, canola");
//   - the Food's head noun must be one the line names ("flour" never picks
//     "Tortillas, ..., flour"; "egg" never picks "Egg, yolk");
//   - the preparation state must agree: raw / cooked / dried / canned /
//     frozen ("cooked rice" -> "Rice, ..., cooked"). A line that names no
//     state is read as the ingredient as bought (raw, dry, uncooked): that is
//     how recipe ingredient lists are written, and it is recorded as an
//     assumption;
//   - extra qualifiers the line does not ask for cost a little
//     ("Egg, white" for "egg"), generic USDA words cost nothing.
//
// The result carries a confidence and the reasons it is not certain. Only a
// clear winner (`auto`) may be pre-linked in the review form; everything
// else stays a suggestion the user must confirm (Master §18). Nothing here
// estimates a nutrient.

export type PrepState = 'raw' | 'cooked' | 'dried' | 'canned' | 'frozen';

export interface MatchCandidate {
  food_id: string;
  /** Display name (USDA description for USDA foods). */
  name: string;
  matched_alias_source: string | null;
}

export type MatchReason =
  /** The line names no state; the as-bought state was used. */
  | 'state_assumed'
  /** The line names a state the chosen Food does not have. */
  | 'state_mismatch'
  /** Some words of the line are not in the Food's name. */
  | 'partial_name'
  /** Another Food fits about as well; the user must choose. */
  | 'ambiguous'
  /** The match relies on an AI-made alias. */
  | 'unvalidated_alias'
  /** "optional", "for garnish", "to serve": may not be eaten as listed. */
  | 'optional_line';

export interface RankedCandidate extends MatchCandidate {
  score: number;
  state: PrepState | null;
  coverage: number;
}

export interface MatchDecision {
  best: RankedCandidate;
  alternatives: RankedCandidate[];
  line_state: PrepState | null;
  confidence: number;
  match_kind: 'exact' | 'prefix' | 'contains';
  /** Clear enough to be pre-linked for review. */
  auto: boolean;
  reasons: MatchReason[];
}

export const AUTO_MATCH_MIN_SCORE = 0.85;
export const AUTO_MATCH_MIN_MARGIN = 0.1;
/** Below this, the best candidate is not worth showing as a suggestion. */
export const MIN_SUGGESTION_SCORE = 0.5;

// ---- words -----------------------------------------------------------------

const STATE_WORDS: ReadonlyArray<[PrepState, readonly string[]]> = [
  ['canned', ['canned', 'tinned', 'jarred', 'can', 'cans', 'tin', 'tins', 'jar']],
  ['frozen', ['frozen']],
  [
    'cooked',
    ['cooked', 'boiled', 'roasted', 'baked', 'fried', 'broiled', 'grilled', 'steamed', 'braised', 'stewed', 'poached', 'sauteed', 'sautéed', 'browned', 'toasted', 'microwaved', 'scrambled', 'heat', 'leftover'],
  ],
  ['dried', ['dried', 'dehydrated', 'sun-dried', 'sundried']],
  ['raw', ['raw', 'fresh', 'uncooked', 'dry', 'unprepared']],
];
const STATE_OF_WORD = new Map<string, PrepState>(STATE_WORDS.flatMap(([state, words]) => words.map((w) => [w, state] as [string, PrepState])));
/** When a name has several state words ("dry roasted"), the strongest wins. */
const STATE_PRECEDENCE: readonly PrepState[] = ['canned', 'frozen', 'cooked', 'dried', 'raw'];

/** USDA words that do not distinguish one food from another. */
const GENERIC = new Set([
  'raw', 'fresh', 'whole', 'regular', 'all', 'type', 'types', 'variety', 'varieties', 'commercial', 'commercially', 'prepared', 'year', 'round',
  'average', 'include', 'includes', 'food', 'foods', 'usda', "usda's", 'usdas', 'distribution', 'program', 'for', 'the', 'and', 'or', 'with', 'of',
  'in', 'enriched', 'granulated', 'table', 'smooth', 'style', 'common', 'most', 'kernel', 'kernels', 'mature', 'seed', 'seeds', 'edible', 'meat',
  'only', 'skinless', 'boneless', 'broiler', 'broilers', 'fryer', 'fryers', 'long-grain', 'long', 'grain', 'ripe', 'salad', 'cooking', 'red', 'yellow',
  'plain', 'unsweetened', 'fluid', 'milkfat', 'nigari', 'sulfate', 'chloride', 'calcium', 'magnesium', 'unprepared', 'deglet', 'noor', 'european',
  'such', 'as', 'thompson', 'seedless', 'cultured', 'drinking', 'tap', 'bleached', 'all-purpose', 'leaves', 'leaf', 'flesh',
  'separable', 'lean', 'retail', 'parts', 'stock', 'shoyu', 'made', 'from', 'tops', 'bulb', 'nlea', 'dry', 'heat', 'moist',
  'packed', 'vitamin', 'fortified', 'unfortified', 'includes', 'quick',
]);
/** Words that do distinguish, but are what a recipe usually means by default. */
const SOFT = new Set(['salted', 'salt', 'without', 'added', 'drained', 'solids', 'liquids', 'solid', 'liquid', 'unenriched', 'farmed', 'atlantic', 'light', 'water']);

/** Leading USDA groupings that are not the food itself ("Spices, pepper, black"). */
const CATEGORY_PREFIXES = new Set([
  'spices', 'nuts', 'seeds', 'fish', 'crustaceans', 'mollusks', 'cereals', 'beverages', 'leavening agents', 'candies', 'tomato products', 'cheese',
  'salad dressing', 'oil', 'syrups',
]);

/** Line words that are never part of the food's name. */
const LINE_NOISE = new Set([
  'a', 'an', 'of', 'the', 'about', 'approx', 'approximately', 'plus', 'extra', 'more', 'some', 'few', 'optional', 'heaped', 'heaping', 'level',
  'scant', 'generous', 'large', 'medium', 'small', 'big', 'jumbo', 'freshly', 'chopped', 'finely', 'roughly', 'coarsely', 'thinly', 'thickly',
  'minced', 'diced', 'sliced', 'grated', 'shredded', 'crushed', 'peeled', 'trimmed', 'halved', 'quartered', 'beaten', 'melted', 'softened',
  'room', 'temperature', 'cold', 'warm', 'hot', 'packed', 'lightly', 'firmly', 'sifted', 'rinsed', 'washed', 'divided', 'to', 'taste',
  'for', 'serving', 'serve', 'garnish', 'and', 'or', 'cubed', 'cut', 'into', 'pieces', 'piece', 'wedges', 'rings', 'strips', 'inch', 'cm',
  'mashed', 'pureed', 'zested', 'juiced', 'seeded', 'deseeded', 'stemmed', 'pitted', 'cored', 'torn', 'well', 'good', 'quality', 'organic',
  'store-bought', 'homemade', 'florets', 'floret', 'ground', 'ripe', 'whole', 'your', 'favorite', 'favourite', 'such', 'as', 'at', 'if', 'desired', 'needed', 'like',
]);

const OPTIONAL_PATTERN = /\b(optional|for (?:garnish|garnishing|serving|decoration|dusting|greasing|frying)|to (?:serve|garnish)|if desired)\b/i;

/** A few recipe words that USDA names differently. Applied to whole words. */
const SYNONYMS: ReadonlyArray<[RegExp, string]> = [
  [/\b(?:whole[- ]wheat|wholemeal) flour\b/g, 'wheat flour whole-grain'],
  [/\b(?:all[- ]purpose|plain|white) flour\b/g, 'wheat flour white'],
  [/(?<!(?:wheat|almond|coconut|rice|corn|oat|chickpea|gram|buckwheat|rye|spelt) )\bflour\b/g, 'wheat flour white'],
  [/\b(?:caster|castor|white|granulated) sugar\b/g, 'sugar granulated'],
  [/\b(?:icing|confectioners'?|powdered) sugar\b/g, 'sugars powdered'],
  [/\b(?:light |dark )?brown sugar\b/g, 'sugars brown'],
  [/\b(?:green|spring) onions?\b/g, 'onions scallions'],
  [/\bgarbanzo(?: beans?)?\b/g, 'chickpeas'],
  [/\bcourgettes?\b/g, 'zucchini'],
  [/\baubergines?\b/g, 'eggplant'],
  [/\b(?:bell )?capsicums?\b/g, 'peppers sweet'],
  [/\bbell peppers?\b/g, 'peppers sweet'],
  [/\bcoriander leaves\b/g, 'cilantro'],
  [/\bunsalted\b/g, 'without salt'],
  [/\bextra[- ]virgin\b/g, ''],
  [/\bkosher salt|sea salt\b/g, 'salt'],
  [/\bbaking soda|bicarbonate of soda|bicarb soda\b/g, 'baking soda'],
  [/(?<!onions )\bscallions?\b/g, 'onions scallions'],
];

const IRREGULAR_PLURALS: Record<string, string> = { leaves: 'leaf', halves: 'half', loaves: 'loaf', knives: 'knife', olives: 'olive', chives: 'chive', cloves: 'clove' };

export function singular(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith('ies') && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith('oes')) return word.slice(0, -2);
  if (IRREGULAR_PLURALS[word]) return IRREGULAR_PLURALS[word];
  if (/(?:ch|sh|x|ss)es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('ss') && !word.endsWith('us')) return word.slice(0, -1);
  return word;
}

function words(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\s'-]/gu, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^['-]+|['-]+$/g, ''))
    .filter(Boolean);
}

function stateOf(tokens: readonly string[]): PrepState | null {
  const found = new Set(tokens.map((t) => STATE_OF_WORD.get(t)).filter((s): s is PrepState => !!s));
  return STATE_PRECEDENCE.find((s) => found.has(s)) ?? null;
}

/** The state a line asks for, from its own words (before any comma note:
 * "spinach, washed" is not a state). */
export function lineState(line: string): PrepState | null {
  const head = line.replace(/\([^)]*\)/g, ' ').split(/[,;]/)[0] ?? line;
  return stateOf(words(head));
}

export function isOptionalLine(line: string): boolean {
  return OPTIONAL_PATTERN.test(line);
}

/** The food words of a search term: no state words, no noise, singular. */
export function termTokens(term: string): string[] {
  let text = term.toLowerCase();
  for (const [pattern, replacement] of SYNONYMS) text = text.replace(pattern, replacement);
  return [...new Set(words(text).filter((w) => !STATE_OF_WORD.has(w) && !LINE_NOISE.has(w)).map(singular))];
}

interface NameShape {
  head: string[];
  /** Parenthetical words of the head ("Coriander (cilantro) leaves"). */
  headAlternates: string[];
  rest: string[];
  all: Set<string>;
  state: PrepState | null;
}

export function nameShape(name: string): NameShape {
  // Commas inside parentheses ("Chickpeas (garbanzo beans, bengal gram)") do not split the name.
  const protectedName = name.toLowerCase().replace(/\([^)]*\)/g, (group) => group.replace(/,/g, ' '));
  const segments = protectedName.split(',').map((s) => s.trim()).filter(Boolean);
  if (segments.length > 1 && CATEGORY_PREFIXES.has(segments[0] ?? '')) segments.shift();
  const headText = segments[0] ?? '';
  const alternates = [...headText.matchAll(/\(([^)]*)\)/g)].flatMap((m) => words(m[1] ?? '')).map(singular);
  const head = words(headText.replace(/\([^)]*\)/g, ' ')).map(singular);
  const restText = segments.slice(1).join(' ').replace(/\([^)]*\)/g, ' ');
  const rest = words(restText).map(singular);
  const raw = words(name.toLowerCase().replace(/[()]/g, ' '));
  return { head, headAlternates: alternates, rest, all: new Set([...raw.map(singular), ...raw]), state: stateOf(raw) };
}

/** Score in [0, 1] for one candidate against the line's food words and state. */
export function scoreCandidate(tokens: readonly string[], wantedState: PrepState | null, candidate: MatchCandidate, lineWords: ReadonlySet<string> = new Set()): RankedCandidate {
  const shape = nameShape(candidate.name);
  let score = 1;
  const found = tokens.filter((t) => shape.all.has(t));
  const coverage = tokens.length ? found.length / tokens.length : 0;
  score -= (tokens.length - found.length) * 0.25;

  // The head noun must be one the line names (or its parenthetical alternate).
  const headMissing = shape.head.filter((w) => !GENERIC.has(w) && !tokens.includes(w));
  const alternateOk = shape.headAlternates.length > 0 && shape.headAlternates.some((w) => tokens.includes(w));
  if (headMissing.length && !alternateOk) score -= 0.3 * headMissing.length;

  // Qualifiers the line did not ask for.
  for (const w of shape.rest) {
    if (tokens.includes(w) || lineWords.has(w) || GENERIC.has(w) || STATE_OF_WORD.has(w) || w.length < 2) continue;
    score -= SOFT.has(w) ? 0.03 : 0.1;
  }

  // Preparation state.
  const state = shape.state;
  if (wantedState) {
    // A Food that names no state is usually as bought: fine for "fresh", not for "roasted".
    if (state !== wantedState) score -= state === null ? (wantedState === 'raw' ? 0.05 : 0.2) : 0.35;
  } else if (state === 'cooked' || state === 'canned' || state === 'frozen') {
    score -= 0.2;
  } else if (state === 'dried') {
    score -= 0.05;
  }
  if (candidate.matched_alias_source === 'ai_matched') score -= 0.2;
  return { ...candidate, score: Math.max(0, Math.round(score * 100) / 100), state, coverage };
}

export function rankCandidates(line: string, term: string, candidates: readonly MatchCandidate[]): MatchDecision | null {
  const tokens = termTokens(term);
  if (!tokens.length || !candidates.length) return null;
  const wantedState = lineState(line);
  const lineWords = new Set(words(line).flatMap((w) => [w, singular(w)]));
  const unique = [...new Map(candidates.map((c) => [c.food_id, c])).values()];
  const ranked = unique
    .map((c) => scoreCandidate(tokens, wantedState, c, lineWords))
    .filter((c) => c.coverage > 0)
    .sort((a, b) => b.score - a.score || a.name.length - b.name.length || (a.name < b.name ? -1 : 1));
  const best = ranked[0];
  if (!best || best.score < MIN_SUGGESTION_SCORE) return null;
  const second = ranked[1];

  const reasons: MatchReason[] = [];
  if (best.coverage < 1) reasons.push('partial_name');
  if (wantedState === null && ranked.some((c) => c.coverage === 1 && c.state !== best.state)) reasons.push('state_assumed');
  if (wantedState !== null && (best.state ?? (wantedState === 'raw' ? 'raw' : null)) !== wantedState) reasons.push('state_mismatch');
  if (second && Math.round((best.score - second.score) * 100) < Math.round(AUTO_MATCH_MIN_MARGIN * 100)) reasons.push('ambiguous');
  if (best.matched_alias_source === 'ai_matched') reasons.push('unvalidated_alias');
  if (isOptionalLine(line)) reasons.push('optional_line');

  const blocking = reasons.filter((r) => r !== 'state_assumed');
  const auto = best.score >= AUTO_MATCH_MIN_SCORE && blocking.length === 0;
  const match_kind = best.score >= 0.999 ? 'exact' : best.score >= 0.7 ? 'prefix' : 'contains';
  return { best, alternatives: ranked.slice(1, 4), line_state: wantedState, confidence: best.score, match_kind, auto, reasons };
}
