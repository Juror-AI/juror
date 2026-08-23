import type { Env } from './env';
import { deleteWorkspaceCorpus, maybeEnqueueCorpusEvent, writeCorpusBatch, type CorpusEventV1, type QueueMessage, type WebhookQueueMessage } from './corpus';
import { processGitHubWebhook } from './github-webhook';
import { processStripeWebhook } from './stripe';
import { emitStripeMeterEvent } from './billing';
import { deleteWorkspace } from './workspace-delete';
import { startNextRepositoryQa } from './workflows';

async function markDelivery(env: Env, message: WebhookQueueMessage, status: 'processed' | 'failed', error?: unknown, attempts = 0): Promise<void> {
  await env.DB.prepare(`UPDATE webhook_delivery SET status = ?, processed_at = ?, attempt_count = ?, error = ? WHERE provider = ? AND delivery_id = ?`)
    .bind(status, new Date().toISOString(), attempts, error ? (error instanceof Error ? error.message : String(error)).slice(0, 500) : null, message.provider, message.deliveryId).run();
}

async function processProviderWebhook(env: Env, message: WebhookQueueMessage): Promise<void> {
  if (message.provider === 'github') {
    await processGitHubWebhook(env, message.eventName, message.payload);
    await maybeEnqueueCorpusEvent(env, message.deliveryId, message.eventName, message.payload);
  } else {
    await processStripeWebhook(env, message.payload);
  }
}

export async function processQueueBatch(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
  const corpusMessages = batch.messages.filter((message) => message.body.kind === 'corpus_event');
  if (corpusMessages.length) {
    try {
      await writeCorpusBatch(env, corpusMessages.map((message) => (message.body as { kind: 'corpus_event'; event: CorpusEventV1 }).event));
      for (const message of corpusMessages) message.ack();
    } catch (error) {
      console.error(JSON.stringify({ message: 'corpus batch failed', queue: batch.queue, error: error instanceof Error ? error.message : String(error) }));
      for (const message of corpusMessages) message.retry({ delaySeconds: Math.min(300, 2 ** Math.min(message.attempts, 8)) });
    }
  }

  for (const queued of batch.messages) {
    const message = queued.body;
    if (message.kind === 'corpus_event') continue;
    try {
      if (message.kind === 'provider_webhook') {
        await processProviderWebhook(env, message);
        await markDelivery(env, message, 'processed', undefined, queued.attempts);
      } else if (message.kind === 'stripe_meter') {
        await emitStripeMeterEvent(env, message.runId);
      } else if (message.kind === 'workspace_delete') {
        await deleteWorkspace(env, message.workspaceId, message.jobId);
      } else if (message.kind === 'qa_admission') {
        await startNextRepositoryQa(env, message.anchorRunId);
      } else {
        await deleteWorkspaceCorpus(env, message.workspaceId, message.jobId);
      }
      queued.ack();
    } catch (error) {
      if (message.kind === 'provider_webhook') await markDelivery(env, message, 'failed', error, queued.attempts);
      console.error(JSON.stringify({ message: 'queued task failed', kind: message.kind, queue: batch.queue, attempts: queued.attempts, error: error instanceof Error ? error.message : String(error) }));
      queued.retry({ delaySeconds: Math.min(300, 2 ** Math.min(queued.attempts, 8)) });
    }
  }
}
