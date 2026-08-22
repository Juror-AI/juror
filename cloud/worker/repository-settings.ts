import { z } from 'zod';

export function initialRepositorySettings(): { reviewEnabled: false } {
  return { reviewEnabled: false };
}

export const repositorySettingsSchema = z.object({
  reviewEnabled: z.boolean().optional(), reviewPreset: z.enum(['starter', 'fast', 'balanced', 'high', 'ultra']).optional(),
  publishMode: z.enum(['all', 'consensus']).optional(), severityFloor: z.enum(['P0', 'P1', 'P2', 'P3']).optional(),
  qaEnabled: z.boolean().optional(), qaTarget: z.string().url().nullable().optional(), allowedOrigins: z.array(z.string().url()).max(20).optional(),
  sessionBootstrap: z.object({ url: z.string().url(), targetOrigin: z.string().url(), readyStorageKey: z.string().min(1).max(128).regex(/^[\x21-\x7e]+$/), secret: z.string().min(32).max(4096) }).nullable().optional(),
  secretHeaders: z.array(z.object({ name: z.string().regex(/^(?:X-[!#$%&'*+\-.^_`|~0-9A-Za-z]+|CF-Access-Client-(?:Id|Secret))$/i), value: z.string().min(8).max(4096), origins: z.array(z.string().url()).min(1).max(20) })).max(20).nullable().optional(),
  resetHook: z.object({ url: z.string().url(), method: z.enum(['POST', 'PUT', 'PATCH', 'DELETE']), secretHeaders: z.array(z.object({ name: z.string().regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/), value: z.string().min(8).max(4096), format: z.enum(['bearer', 'raw']) })).max(20), expectedStatuses: z.array(z.number().int().min(200).max(499)).min(1), timeoutSeconds: z.number().int().min(1).max(60).optional() }).nullable().optional(),
  evidencePolicy: z.object({ screenshot: z.enum(['all', 'failure', 'off']).optional(), trace: z.enum(['all', 'failure', 'off']).optional(), video: z.enum(['all', 'failure', 'off']).optional() }).optional(),
}).strict();

type ScopedSecretHeaders = z.infer<typeof repositorySettingsSchema>['secretHeaders'];

export async function resolveSecretHeadersCiphertext(
  input: ScopedSecretHeaders,
  current: string | null,
  encrypt: (plaintext: string) => Promise<string>,
): Promise<string | null> {
  if (input === undefined) return current;
  if (input === null) return null;
  return encrypt(JSON.stringify(input));
}
