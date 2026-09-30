// Layer 11C — platform administration request contracts. Secrets are never
// accepted: only a secret REFERENCE (`env:NAME`).

import { z } from 'zod';
import { CONNECTION_MODELS, CREDENTIAL_MODELS, PROVIDER_ENVIRONMENTS, PROVIDER_FAMILIES } from './integration.model';
import { SECRET_REFERENCE_PATTERN } from './secrets';

export const WEARABLE_PROVIDERS = ['whoop', 'apple_healthkit', 'android_health_connect'] as const;

export const providerKeySchema = z.string().regex(/^[a-z][a-z0-9_]{1,62}$/, 'provider_key must be a lowercase machine identifier (a-z, 0-9, _).');
export const providerKeyParamSchema = z.object({ provider_key: providerKeySchema });

const capabilityNameSchema = z.string().regex(/^[a-z][a-z0-9_]{1,62}$/);
const capabilityChangeSchema = z.object({
  capability: capabilityNameSchema,
  enabled: z.boolean().optional(),
  priority: z.number().int().min(1).max(1000).optional(),
});

export const secretReferenceSchema = z
  .string()
  .regex(SECRET_REFERENCE_PATTERN, 'secret_reference must be a reference such as env:PROVIDER_API_KEY, never the secret itself.');

export const providerRegisterSchema = z.object({
  provider_key: providerKeySchema,
  display_name: z.string().trim().min(1).max(120),
  provider_family: z.enum(PROVIDER_FAMILIES),
  connection_model: z.enum(CONNECTION_MODELS),
  credential_model: z.enum(CREDENTIAL_MODELS),
  environment: z.enum(PROVIDER_ENVIRONMENTS).optional(),
  wearable_provider: z.enum(WEARABLE_PROVIDERS).optional(),
  capabilities: z.array(capabilityChangeSchema).max(50).default([]),
});
export type ProviderRegisterInput = z.infer<typeof providerRegisterSchema>;

export const providerPatchSchema = z
  .object({
    display_name: z.string().trim().min(1).max(120).optional(),
    enabled: z.boolean().optional(),
    environment: z.enum(PROVIDER_ENVIRONMENTS).optional(),
    /** Validated against the provider adapter's own schema by the service. */
    configuration: z.record(z.string(), z.unknown()).optional(),
    secret_reference: secretReferenceSchema.nullable().optional(),
    capabilities: z.array(capabilityChangeSchema).max(50).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'Provide at least one field to change.' });
export type ProviderPatchInput = z.infer<typeof providerPatchSchema>;

export const routingQuerySchema = z.object({
  family: z.enum(PROVIDER_FAMILIES),
  capability: capabilityNameSchema,
});
export type RoutingQuery = z.infer<typeof routingQuerySchema>;
