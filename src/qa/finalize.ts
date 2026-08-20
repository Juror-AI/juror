/** Finalize controller-owned evidence only after the Actions artifact step is known. */

import type { QaRunResult } from './types.js';

export interface QaEvidenceUploadResult {
  artifactName?: string | null;
  artifactUrl?: string | null;
  error?: string | null;
}

export function markQaInfrastructureError(
  input: QaRunResult,
  reason: string,
  options: { clearArtifactUploads?: boolean } = {},
): QaRunResult {
  const result = structuredClone(input);
  result.outcome = 'infrastructure_error';
  result.conclusion = 'failure';
  if (options.clearArtifactUploads) {
    result.artifacts = result.artifacts.map((artifact) => ({ ...artifact, upload: null }));
  }
  // Public run-result warnings use the short-string (500 character) schema boundary.
  const warning = (reason.trim() || 'QA infrastructure finalization failed').slice(0, 500);
  result.warnings = [...result.warnings.filter((item) => item !== warning), warning].slice(-100);
  return result;
}

function artifactUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('QA artifact URL must be an absolute HTTP(S) URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('QA artifact URL must use HTTP(S)');
  }
  return parsed.toString();
}

/**
 * Return a detached final report so callers never leave a partially mutated result behind.
 * Upload failure is a pipeline failure even when every browser checkpoint passed.
 */
export function finalizeQaEvidence(
  input: QaRunResult,
  upload: QaEvidenceUploadResult,
): QaRunResult {
  const result = structuredClone(input);
  const error = upload.error?.trim();

  if (error) {
    return markQaInfrastructureError(
      result,
      `Evidence upload failed after QA outcome ${result.outcome}: ${error}`,
      { clearArtifactUploads: true },
    );
  }

  const name = upload.artifactName?.trim();
  const rawUrl = upload.artifactUrl?.trim();
  if (!name || name.length > 200 || !rawUrl) {
    throw new Error('Successful QA evidence finalization requires an artifact name and URL');
  }
  const url = artifactUrl(rawUrl);
  result.artifacts = result.artifacts.map((artifact) => ({
    ...artifact,
    upload: { name, url },
  }));
  return result;
}
