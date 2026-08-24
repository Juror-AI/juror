import type { Env } from './env';
import { deleteWorkspaceCorpusObjects } from './corpus';
import { destroyRunSandbox } from './workflows';

async function deleteObjectKeys(bucket: R2Bucket, keys: string[]): Promise<void> {
  for (let index = 0; index < keys.length; index += 1000) await bucket.delete(keys.slice(index, index + 1000));
}

async function cancelWorkspaceRuns(env: Env, workspaceId: string): Promise<void> {
  // The delete endpoint marks queued/running rows cancelled before enqueueing this job so
  // no new work can start. Keep those rows in the termination set even though they now
  // have a completed_at timestamp; the durable Workflow and its Sandbox are independent
  // resources and must still be stopped before any workspace data is removed.
  const active = await env.DB.prepare(`SELECT id, kind, workflow_instance_id FROM run WHERE workspace_id = ? AND workflow_instance_id IS NOT NULL AND (completed_at IS NULL OR status = 'cancelled')`)
    .bind(workspaceId).all<{ id: string; kind: 'review' | 'qa'; workflow_instance_id: string }>();
  for (const run of active.results) {
    await destroyRunSandbox(env, run.kind, run.id);
    try {
      const workflow = run.kind === 'review' ? env.REVIEW_WORKFLOW : env.QA_WORKFLOW;
      await (await workflow.get(run.workflow_instance_id)).terminate();
    } catch { /* A racing workflow may already be terminal. */ }
  }
}

async function reportKeys(env: Env, workspaceId: string): Promise<string[]> {
  const keys: string[] = [];
  let runCursor = '';
  for (;;) {
    const page = await env.DB.prepare(`SELECT id, report_r2_key FROM run WHERE workspace_id = ? AND id > ? ORDER BY id LIMIT 500`)
      .bind(workspaceId, runCursor).all<{ id: string; report_r2_key: string | null }>();
    if (!page.results.length) break;
    keys.push(...page.results.flatMap((run) => run.report_r2_key ? [run.report_r2_key] : []));
    runCursor = page.results.at(-1)!.id;
  }
  let artifactCursor = '';
  for (;;) {
    const page = await env.DB.prepare(`SELECT a.id, a.r2_key FROM artifact_metadata a JOIN run r ON r.id = a.run_id WHERE r.workspace_id = ? AND a.id > ? ORDER BY a.id LIMIT 500`)
      .bind(workspaceId, artifactCursor).all<{ id: string; r2_key: string }>();
    if (!page.results.length) break;
    keys.push(...page.results.map((artifact) => artifact.r2_key));
    artifactCursor = page.results.at(-1)!.id;
  }
  return [...new Set(keys)];
}

export async function deleteWorkspace(env: Env, workspaceId: string, jobId: string): Promise<void> {
  await env.DB.prepare(`UPDATE workspace_deletion_job SET status = 'running', error = NULL WHERE id = ? AND workspace_id = ?`).bind(jobId, workspaceId).run();
  try {
    await cancelWorkspaceRuns(env, workspaceId);
    const reports = await reportKeys(env, workspaceId);
    await deleteObjectKeys(env.REPORTS, reports);
    const corpusObjects = await deleteWorkspaceCorpusObjects(env, workspaceId);
    const workspace = await env.DB.prepare(`SELECT github_installation_id FROM workspace WHERE id = ?`).bind(workspaceId).first<{ github_installation_id: number }>();
    if (workspace) await env.DB.batch([
      env.DB.prepare(`INSERT OR REPLACE INTO deleted_installation (github_installation_id, deleted_at) VALUES (?, ?)`).bind(workspace.github_installation_id, new Date().toISOString()),
      env.DB.prepare(`DELETE FROM workspace WHERE id = ?`).bind(workspaceId),
    ]);
    await env.DB.prepare(`UPDATE workspace_deletion_job SET status = 'succeeded', object_count = ?, completed_at = ? WHERE id = ?`)
      .bind(reports.length + corpusObjects, new Date().toISOString(), jobId).run();
  } catch (error) {
    await env.DB.prepare(`UPDATE workspace_deletion_job SET status = 'failed', error = ?, completed_at = ? WHERE id = ?`)
      .bind(error instanceof Error ? error.message.slice(0, 500) : 'Unknown workspace deletion error', new Date().toISOString(), jobId).run();
    throw error;
  }
}
