// Layer 13A — importing a recipe from a website link.
//
// Flow (synchronous in this layer; the job state is durable so a worker can
// take over later without changing the contract, Master §3.6):
//   1. POST   canonicalize the link, begin_url_recipe_import() -> ImportJob
//             `processing`; fetch the page (pageFetcher.ts), read its
//             schema.org Recipe (recipeJsonLd.ts); complete_url_recipe_import()
//             records RawContent + AiExtraction and sets the job to
//             `needs_confirmation`, or to `retryable_failed` /
//             `permanently_failed` with an error code.
//   2. GET    the import, with the draft for review.
//   3. save   the reviewed recipe through save_url_import_recipe(): the job
//             becomes `succeeded` and the recipe version records its origin,
//             in one transaction (RecipeService.saveImport).
//
// Authorization: starting and saving need `full_management` of the Profile
// (the same as creating a recipe, and import_job_insert_own). Reading an
// import is limited to the Account that requested it (import_job_select_own).
//
// Only `web` sources are fetched. Instagram, TikTok and YouTube links are
// refused before anything is recorded: those platforms do not publish
// recipe data for automated readers and need their own approved approach.

import { createHash, randomUUID } from 'node:crypto';
import { requireProfileScope } from '../../lib/authorize';
import { AppError } from '../../lib/errors';
import type { ScopedDbClient, ScopedDbFactory } from '../../lib/scopedDb';
import type { AuthContext } from '../../types/express';
import { recipeFromOrigin } from '../recipes/recipeOrigin';
import { RECIPE_WRITE_SCOPES } from '../recipes/recipe.service';
import { PageFetchError, type PageFetcher } from './pageFetcher';
import { EXTRACTION_METHOD, EXTRACTOR_VERSION, extractRecipeFromHtml, type RecipeDraft } from './recipeJsonLd';
import type { RecipeImportCreateInput } from './recipeImport.schemas';
import { canonicalizeSourceUrl } from './sourceUrl';

type ImportStatus = 'queued' | 'processing' | 'needs_confirmation' | 'succeeded' | 'retryable_failed' | 'permanently_failed' | 'cancelled';

interface ImportJobRow {
  id: string;
  url_source_id: string;
  trigger_type: string;
  requested_by_profile_id: string | null;
  processing_status: ImportStatus;
  error_code: string | null;
  created_at: string;
  completed_at: string | null;
}

interface ExtractionRow {
  id: string;
  extraction_method: string;
  model_version: string;
  confidence: number;
  status: string;
  extracted_payload: { draft?: RecipeDraft; final_url?: string } | null;
  created_at: string;
}

interface SourceInfo {
  canonical_url: string;
  original_url: string;
  provider: string;
}

const IMPORT_JOB_COLUMNS = 'id, url_source_id, trigger_type, requested_by_profile_id, processing_status, error_code, created_at, completed_at';
const EXTRACTION_COLUMNS = 'id, extraction_method, model_version, confidence, status, extracted_payload, created_at';

const URL_REJECTION_MESSAGES: Record<string, string> = {
  invalid_url: 'That is not a valid web link.',
  unsupported_scheme: 'Only http and https links can be imported.',
  credentials_not_allowed: 'Links with a username or password cannot be imported.',
  port_not_allowed: 'Links with a custom port cannot be imported.',
  host_not_allowed: 'That address cannot be imported. Use a public website link.',
};

export class RecipeImportService {
  constructor(
    private readonly dbFactory: ScopedDbFactory,
    private readonly fetcher: PageFetcher,
  ) {}

  async start(auth: AuthContext, profileId: string, input: RecipeImportCreateInput) {
    const db = this.dbFactory.forUser(auth);
    await requireProfileScope(db, profileId, RECIPE_WRITE_SCOPES);

    const source = canonicalizeSourceUrl(input.url);
    if (!source.ok) {
      throw AppError.validation(URL_REJECTION_MESSAGES[source.reason] ?? 'That link cannot be imported.', {
        issues: [{ path: 'url', message: source.reason }],
      });
    }
    if (source.provider !== 'web') {
      throw AppError.validation(`Importing from ${source.provider} is not available yet. Website links are supported.`, {
        issues: [{ path: 'url', message: 'unsupported_provider' }],
        provider: source.provider,
      });
    }

    const begun = await this.rpc<{ import_job_id: string; replayed: boolean; processing_status: ImportStatus }>(db, 'begin_url_recipe_import', {
      p_profile_id: profileId,
      p_original_url: input.url.trim(),
      p_canonical_url: source.canonicalUrl,
      p_provider: source.provider,
      p_idempotency_key: input.idempotency_key ?? randomUUID(),
      p_extractor_version: EXTRACTOR_VERSION,
    });

    if (!begun.replayed) {
      await this.run(db, begun.import_job_id, input.url.trim());
    }
    return { replayed: begun.replayed, import: await this.load(db, profileId, begun.import_job_id) };
  }

  async get(auth: AuthContext, profileId: string, importId: string) {
    const db = this.dbFactory.forUser(auth);
    await requireProfileScope(db, profileId, RECIPE_WRITE_SCOPES);
    return this.load(db, profileId, importId);
  }

  /** Fetch + extract + record the outcome. Never throws for a page that
   * could not be imported: that is a recorded job outcome, not an error. */
  private async run(db: ScopedDbClient, importJobId: string, url: string): Promise<void> {
    let outcome: Record<string, unknown>;
    try {
      const page = await this.fetcher.fetchPage(url);
      const fetchedAt = new Date().toISOString();
      const extraction = extractRecipeFromHtml(page.html);
      if (!extraction.ok) {
        outcome = { status: 'permanently_failed', error_code: extraction.reason };
      } else {
        const excerpt = extraction.json_ld;
        outcome = {
          status: 'needs_confirmation',
          content_fingerprint: `sha256:${createHash('sha256').update(JSON.stringify(excerpt)).digest('hex')}`,
          raw: { fetched_at: fetchedAt, excerpt },
          extraction: {
            method: EXTRACTION_METHOD,
            model_version: EXTRACTOR_VERSION,
            confidence: extraction.confidence,
            status: extraction.status,
            payload: { draft: extraction.draft, final_url: page.finalUrl },
          },
        };
      }
    } catch (err) {
      if (!(err instanceof PageFetchError)) {
        // Unexpected: record it so the job never stays `processing`, then rethrow.
        await this.rpc(db, 'complete_url_recipe_import', { p_import_job_id: importJobId, p_outcome: { status: 'retryable_failed', error_code: 'internal_error' } }).catch(() => undefined);
        throw err;
      }
      outcome = { status: err.retryable ? 'retryable_failed' : 'permanently_failed', error_code: err.code };
    }
    await this.rpc(db, 'complete_url_recipe_import', { p_import_job_id: importJobId, p_outcome: outcome });
  }

  private async load(db: ScopedDbClient, profileId: string, importId: string) {
    const jobs = await db.select<ImportJobRow>('import_job', {
      columns: IMPORT_JOB_COLUMNS,
      eq: { id: importId, requested_by_profile_id: profileId },
      limit: 1,
    });
    const job = jobs[0];
    if (!job) throw AppError.notFound('Import not found.');

    const [extractions, source, savedRecipeId, existingRecipeId] = await Promise.all([
      db.select<ExtractionRow>('ai_extraction', { columns: EXTRACTION_COLUMNS, eq: { import_job_id: job.id }, order: { column: 'created_at', ascending: false }, limit: 1 }),
      this.rpc<SourceInfo | null>(db, 'url_recipe_import_source', { p_import_job_id: job.id }),
      recipeFromOrigin(db, profileId, 'origin_import_job_id', job.id),
      recipeFromOrigin(db, profileId, 'origin_url_source_id', job.url_source_id),
    ]);
    const extraction = extractions[0];
    return {
      id: job.id,
      profile_id: profileId,
      status: job.processing_status,
      trigger_type: job.trigger_type,
      error_code: job.error_code,
      source: source ? { url: source.canonical_url, original_url: source.original_url, provider: source.provider } : null,
      extraction: extraction
        ? { id: extraction.id, method: extraction.extraction_method, version: extraction.model_version, confidence: Number(extraction.confidence), status: extraction.status }
        : null,
      draft: extraction?.extracted_payload?.draft ?? null,
      /** The recipe saved from THIS import. */
      recipe_id: savedRecipeId,
      /** A recipe in this Profile already imported from the same source
       * (by this or an earlier import); saving again is refused. */
      existing_recipe_id: existingRecipeId,
      created_at: job.created_at,
      completed_at: job.completed_at,
    };
  }

  private async rpc<T>(db: ScopedDbClient, fn: string, args: Record<string, unknown>): Promise<T> {
    try {
      return await db.rpc<T>(fn, args);
    } catch (err) {
      throw mapImportDbError(err);
    }
  }
}

export function mapImportDbError(err: unknown): unknown {
  const code = (err as { code?: unknown }).code;
  if (code === '42501') return AppError.forbidden('This operation is not permitted for this profile.');
  if (code === 'P0002') return AppError.notFound('Import not found.');
  if (code === '22023') return AppError.validation('This import request is not valid.');
  if (code === '55000') return AppError.conflict('This import is not ready to be saved.');
  if (code === '23505') return AppError.conflict('This import was already handled.');
  return err;
}
