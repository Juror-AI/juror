import { hmacHex, timingSafeEqual } from './crypto';
import type { Env, Principal } from './env';
import { HTTPException } from 'hono/http-exception';

type StripeObject = Record<string, any>;

export async function verifyStripeSignature(secret: string, body: string, header: string | null, toleranceSeconds = 300): Promise<boolean> {
  if (!header) return false;
  const fields = header.split(',').map((part) => {
    const separator = part.indexOf('=');
    return separator < 1 ? ['', ''] as const : [part.slice(0, separator).trim(), part.slice(separator + 1).trim()] as const;
  });
  const timestamp = fields.find(([name]) => name === 't')?.[1];
  const signatures = fields.filter(([name]) => name === 'v1').map(([, value]) => value);
  if (!timestamp || !signatures.length || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > toleranceSeconds) return false;
  const expected = await hmacHex(secret, `${timestamp}.${body}`);
  return signatures.some((signature) => timingSafeEqual(expected, signature));
}

export async function processStripeWebhook(env: Env, event: StripeObject): Promise<void> {
  const object = event.data?.object ?? {};
  const timestamp = new Date((event.created ?? Math.floor(Date.now() / 1000)) * 1000).toISOString();
  if (event.type === 'checkout.session.completed') {
    const workspaceId = object.metadata?.workspace_id ?? object.client_reference_id;
    if (workspaceId && object.customer) {
      const workspace = await env.DB.prepare('SELECT id FROM workspace WHERE id = ?').bind(workspaceId).first();
      if (workspace) await env.DB.batch([
        env.DB.prepare(`INSERT INTO stripe_customer (workspace_id, stripe_customer_id, stripe_subscription_id, payment_state, updated_at) VALUES (?, ?, ?, 'active', ?) ON CONFLICT(workspace_id) DO UPDATE SET stripe_customer_id = excluded.stripe_customer_id, stripe_subscription_id = excluded.stripe_subscription_id, payment_state = 'active', updated_at = excluded.updated_at`).bind(workspaceId, object.customer, object.subscription ?? null, timestamp),
        env.DB.prepare(`UPDATE workspace SET billing_state = 'active', updated_at = ? WHERE id = ?`).bind(timestamp, workspaceId),
      ]);
    }
  }
  if (event.type.startsWith('customer.subscription.')) {
    let customer = await env.DB.prepare('SELECT workspace_id FROM stripe_customer WHERE stripe_customer_id = ?').bind(object.customer).first<{ workspace_id: string }>();
    const workspaceId = object.metadata?.workspace_id;
    if (!customer && workspaceId) {
      const workspace = await env.DB.prepare('SELECT id FROM workspace WHERE id = ?').bind(workspaceId).first();
      if (workspace) {
        await env.DB.prepare(`INSERT INTO stripe_customer (workspace_id, stripe_customer_id, stripe_subscription_id, payment_state, updated_at) VALUES (?, ?, ?, 'active', ?) ON CONFLICT(workspace_id) DO UPDATE SET stripe_customer_id = excluded.stripe_customer_id, stripe_subscription_id = excluded.stripe_subscription_id, updated_at = excluded.updated_at`).bind(workspaceId, object.customer, object.id, timestamp).run();
        customer = { workspace_id: workspaceId };
      }
    }
    if (!customer) return;
    const state = object.status === 'active' || object.status === 'trialing' ? 'active' : object.status === 'past_due' ? 'past_due' : 'paused';
    await env.DB.batch([
      env.DB.prepare('UPDATE stripe_customer SET stripe_subscription_id = ?, stripe_subscription_item_id = ?, payment_state = ?, updated_at = ? WHERE workspace_id = ?').bind(object.id, object.items?.data?.[0]?.id ?? null, state, timestamp, customer.workspace_id),
      env.DB.prepare('UPDATE workspace SET billing_state = ?, updated_at = ? WHERE id = ?').bind(state, timestamp, customer.workspace_id),
    ]);
  }
  if (event.type.startsWith('invoice.')) {
    const customer = await env.DB.prepare('SELECT workspace_id FROM stripe_customer WHERE stripe_customer_id = ?').bind(object.customer).first<{ workspace_id: string }>();
    if (!customer) return;
    await env.DB.prepare(`INSERT INTO invoice (id, workspace_id, stripe_invoice_id, period_start, period_end, amount_micro_usd, status, hosted_invoice_url, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(stripe_invoice_id) DO UPDATE SET amount_micro_usd = excluded.amount_micro_usd, status = excluded.status, hosted_invoice_url = excluded.hosted_invoice_url, updated_at = excluded.updated_at`)
      .bind(`invoice_${object.id}`, customer.workspace_id, object.id, new Date((object.period_start ?? 0) * 1000).toISOString(), new Date((object.period_end ?? 0) * 1000).toISOString(), Math.round((object.amount_due ?? 0) * 10_000), object.status ?? 'open', object.hosted_invoice_url ?? null, timestamp).run();
    if (event.type === 'invoice.payment_failed') await env.DB.prepare(`UPDATE workspace SET billing_state = 'past_due', updated_at = ? WHERE id = ?`).bind(timestamp, customer.workspace_id).run();
  }
}

async function stripePost(env: Env, path: string, body: URLSearchParams, idempotencyKey: string): Promise<any> {
  if (!env.STRIPE_SECRET_KEY) throw new HTTPException(503, { message: 'Billing is not configured' });
  const response = await fetch(`https://api.stripe.com/v1${path}`, { method: 'POST', headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'content-type': 'application/x-www-form-urlencoded', 'idempotency-key': idempotencyKey }, body });
  if (!response.ok) throw new Error(`Stripe request failed (${response.status})`);
  return response.json();
}

export async function createBillingPortal(env: Env, principal: Principal): Promise<string> {
  const customer = await env.DB.prepare('SELECT stripe_customer_id FROM stripe_customer WHERE workspace_id = ?').bind(principal.workspaceId).first<{ stripe_customer_id: string }>();
  if (!customer) throw new HTTPException(409, { message: 'Billing is not active' });
  const body = new URLSearchParams({ customer: customer.stripe_customer_id, return_url: `${env.APP_URL}/usage` });
  const session = await stripePost(env, '/billing_portal/sessions', body, `portal-${principal.workspaceId}-${crypto.randomUUID()}`) as { url: string };
  return session.url;
}

export async function createCheckout(env: Env, principal: Principal): Promise<string> {
  const priceId = String(env.STRIPE_PRICE_ID);
  if (!priceId || priceId === 'unconfigured' || priceId.includes('replace_before_deploy')) throw new HTTPException(503, { message: 'Billing is not configured' });
  const body = new URLSearchParams();
  body.set('mode', 'subscription');
  body.set('success_url', `${env.APP_URL}/usage?billing=success`);
  body.set('cancel_url', `${env.APP_URL}/usage?billing=cancelled`);
  body.set('line_items[0][price]', env.STRIPE_PRICE_ID);
  body.set('line_items[0][quantity]', '1');
  body.set('metadata[workspace_id]', principal.workspaceId);
  body.set('subscription_data[metadata][workspace_id]', principal.workspaceId);
  const existing = await env.DB.prepare('SELECT stripe_customer_id FROM stripe_customer WHERE workspace_id = ?').bind(principal.workspaceId).first<{ stripe_customer_id: string }>();
  if (existing) body.set('customer', existing.stripe_customer_id);
  else body.set('client_reference_id', principal.workspaceId);
  const session = await stripePost(env, '/checkout/sessions', body, `checkout-${principal.workspaceId}-${crypto.randomUUID()}`) as { url: string };
  return session.url;
}
