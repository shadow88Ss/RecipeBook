// Layer 11D — external product candidates for ordinary authenticated users.
//
// Barcode lookup is internal-first: the Layer 11A canonical GTIN is looked
// up in MyRecipeBook's own Product/Barcode reference data, and external
// providers are asked only when no active internal Barcode exists. Provider
// order is the configured capability priority (Layer 11C routing); nothing
// here names a provider.
//
// Every external answer is an unconfirmed ExternalProductCandidate: nothing
// is written to Product, ProductLabelVersion, ProductNutrient,
// ProductServing, Barcode, Food or any user table, and candidates cannot be
// logged (meal logging requires a canonical Product). Responses carry safe
// provenance only — no credential, token, secret reference, raw provider
// payload, configuration or per-provider health detail.

import { AppError } from '../../lib/errors';
import type { ScopedDbFactory } from '../../lib/scopedDb';
import type { AuthContext } from '../../types/express';
import type { AdapterRegistry, ProductDataAdapter } from '../integrations/adapters';
import { isOwnCandidate, type AggregateStatus, type ExecutionResult, type ProviderExecutor } from '../integrations/execution';
import { providerDisagreements, type ExternalProductCandidate } from '../integrations/productData';
import { ProviderRouter } from '../integrations/routing';
import { BARCODE_RULES_VERSION, normalizeBarcode, type BarcodeType } from '../products/barcode';
import type { ProductService } from '../products/product.service';
import type { BarcodeLookupQuery, ExternalSearchQuery } from './externalProduct.schemas';

export type ConsumerLookupStatus = 'found' | 'not_found' | 'temporarily_unavailable' | 'not_configured';

function consumerStatus(status: AggregateStatus): ConsumerLookupStatus {
  return status === 'unavailable' ? 'temporarily_unavailable' : status === 'no_provider' ? 'not_configured' : status;
}

const productData = (adapter: unknown) => adapter as ProductDataAdapter;

export class ExternalProductService {
  private readonly router: ProviderRouter;

  constructor(
    private readonly dbFactory: ScopedDbFactory,
    registry: AdapterRegistry,
    private readonly executor: ProviderExecutor,
    private readonly products: ProductService,
  ) {
    this.router = new ProviderRouter(registry);
  }

  async lookupBarcode(auth: AuthContext, code: string, query: BarcodeLookupQuery, requestId: string | null) {
    // Invalid codes are refused here, before any lookup or provider call.
    const normalized = normalizeBarcode(code, query.type as BarcodeType | undefined);
    if (!normalized.ok) {
      throw AppError.validation('Invalid barcode.', { reason: normalized.reason, issues: [{ path: 'code', message: normalized.message }] });
    }
    const submitted = { rules_version: BARCODE_RULES_VERSION, digits: normalized.digits, barcode_type: normalized.barcode_type, canonical_gtin: normalized.gtin };

    try {
      const internal = await this.products.lookupBarcode(auth, normalized.digits, normalized.barcode_type);
      return { submitted, source: 'internal' as const, match: internal.match, product: internal.product, candidates: [], disagreements: [], external_lookup: null };
    } catch (err) {
      if (!(err instanceof AppError) || err.httpStatus !== 404) throw err;
    }

    const db = this.dbFactory.forUser(auth);
    const plan = await this.router.plan(db, 'product_data', 'barcode_lookup');
    const outcome = await this.executor.run<ExternalProductCandidate>(plan, (definition, ctx) => productData(definition.adapter).lookupBarcode?.(ctx, normalized.gtin) ?? Promise.resolve(null), {
      mode: query.mode,
      requestId,
      validate: (c, route) => isOwnCandidate(c, route) && c.barcode?.canonical_gtin === normalized.gtin,
    });
    const candidates = outcome.results.map((r) => r.value);
    return {
      submitted,
      source: candidates.length ? ('external_candidate' as const) : ('none' as const),
      match: null,
      product: null,
      candidates,
      /** Highest-priority answer; alternates stay as separate candidates. */
      preferred_candidate: candidates[0] ? { provider_key: candidates[0].provider_key, external_product_id: candidates[0].external_product_id } : null,
      disagreements: providerDisagreements(candidates),
      external_lookup: this.lookupSummary(outcome),
      next_step: candidates.length ? ('confirmation_required_before_use' as const) : null,
    };
  }

  async search(auth: AuthContext, query: ExternalSearchQuery, requestId: string | null) {
    const db = this.dbFactory.forUser(auth);
    const plan = await this.router.plan(db, 'product_data', 'product_search');
    const outcome = await this.executor.run<ExternalProductCandidate[]>(
      plan,
      (definition, ctx) => productData(definition.adapter).searchProducts?.(ctx, { query: query.q, limit: query.limit }) ?? Promise.resolve(null),
      { mode: query.mode, requestId, isEmpty: (v) => v.length === 0, validate: (v, route) => v.every((c) => isOwnCandidate(c, route)) },
    );
    return {
      query: query.q,
      // External candidates only: never mixed into canonical Product search.
      source: 'external_candidate' as const,
      items: outcome.results.flatMap((r) => r.value).slice(0, query.mode === 'first' ? query.limit : undefined),
      external_lookup: this.lookupSummary(outcome),
    };
  }

  async candidate(auth: AuthContext, providerKey: string, externalId: string, requestId: string | null) {
    const db = this.dbFactory.forUser(auth);
    const plan = await this.router.plan(db, 'product_data', 'nutrition_lookup');
    const routes = plan.routes.filter((r) => r.kind === 'external' && r.provider_key === providerKey);
    if (!routes.length) throw AppError.notFound('This product source is not available.');
    const outcome = await this.executor.run<ExternalProductCandidate>(
      { ...plan, routes },
      (definition, ctx) => productData(definition.adapter).fetchNutrition?.(ctx, externalId) ?? Promise.resolve(null),
      { mode: 'first', requestId, validate: (c, route) => isOwnCandidate(c, route) && c.external_product_id === externalId },
    );
    const [found] = outcome.results;
    if (found) return { source: 'external_candidate' as const, candidate: found.value };
    if (outcome.status === 'not_found') throw AppError.notFound('No external product has this identifier.');
    throw AppError.unavailable('The product source is temporarily unavailable.');
  }

  /** Safe aggregate only: no per-provider failure codes or health. */
  private lookupSummary(outcome: ExecutionResult<unknown>) {
    return {
      status: consumerStatus(outcome.status),
      providers_answered: outcome.results.map((r) => r.provider_key),
      complete: outcome.attempts.every((a) => a.outcome === 'found' || a.outcome === 'not_found'),
    };
  }
}
