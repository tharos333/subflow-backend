import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { stripeBilling } from '../services/billing/stripeBilling.service';
import { db } from '../db/client';
import { logger } from '../utils/logger';
import { dunningQueue } from '../jobs/workers';

export const stripeWebhookRouter = Router();

stripeWebhookRouter.post('/', async (req: Request, res: Response) => {
  const sig = req.headers['stripe-signature'] as string;
  let event: Stripe.Event;
  try {
    event = stripeBilling.verifyWebhookSignature(req.body as Buffer, sig);
  } catch (err) {
    logger.warn(`Stripe webhook invalid: ${(err as Error).message}`);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  const existing = await db('webhook_logs').where({ source: 'stripe', event_id: event.id }).first().catch(() => null);
  if (existing?.status === 'processed') return res.json({ received: true });

  const [log] = await db('webhook_logs').insert({
    source: 'stripe', event_type: event.type, event_id: event.id,
    payload: JSON.stringify(event), status: 'received', attempts: 1,
  }).returning('id').catch(() => [{ id: null }]);

  try {
    await processStripeEvent(event);
    if (log?.id) await db('webhook_logs').where({ id: log.id }).update({ status: 'processed', processed_at: new Date() });
  } catch (err) {
    logger.error(`Stripe webhook handler failed: ${(err as Error).message}`);
    if (log?.id) await db('webhook_logs').where({ id: log.id }).update({ status: 'failed', error_message: (err as Error).message });
    return res.status(500).json({ error: 'Handler failed' });
  }
  res.json({ received: true });
});

async function processStripeEvent(event: Stripe.Event) {
  switch (event.type) {
    case 'invoice.paid': {
      const invoice = event.data.object as Stripe.Invoice;
      const subId = invoice.subscription as string;
      const localSub = await db('subscriptions').where({ stripe_subscription_id: subId }).first();
      if (!localSub) break;
      await db('invoices').insert({
        subscription_id: localSub.id, customer_id: localSub.customer_id,
        stripe_invoice_id: invoice.id, status: 'paid',
        amount_due: invoice.amount_due / 100, amount_paid: invoice.amount_paid / 100,
        currency: invoice.currency.toUpperCase(),
        paid_at: new Date(), period_start: new Date(invoice.period_start * 1000),
        period_end: new Date(invoice.period_end * 1000),
      }).onConflict('stripe_invoice_id').merge(['status','amount_paid','paid_at']).catch(() => {});
      await db('subscriptions').where({ id: localSub.id }).update({ status: 'active', payment_attempts: 0, dunning_started_at: null });
      break;
    }
    case 'invoice.payment_failed': {
      const invoice = event.data.object as Stripe.Invoice;
      const localSub = await db('subscriptions').where({ stripe_subscription_id: invoice.subscription as string }).first();
      if (!localSub) break;
      await db('subscriptions').where({ id: localSub.id }).update({ status: 'past_due', last_payment_attempt: new Date() });
      await dunningQueue.add('retry-payment', { subscriptionId: localSub.id, attempt: 1 }, { delay: 24 * 60 * 60 * 1000 });
      break;
    }
    case 'customer.subscription.updated': {
      const s = event.data.object as Stripe.Subscription;
      await db('subscriptions').where({ stripe_subscription_id: s.id }).update({
        status: s.status === 'canceled' ? 'cancelled' : s.status,
        current_period_start: new Date(s.current_period_start * 1000),
        current_period_end: new Date(s.current_period_end * 1000),
        next_billing_date: new Date(s.current_period_end * 1000),
        cancel_at_period_end: s.cancel_at_period_end,
      }).catch(() => {});
      break;
    }
    case 'customer.subscription.deleted': {
      const s = event.data.object as Stripe.Subscription;
      await db('subscriptions').where({ stripe_subscription_id: s.id })
        .update({ status: 'cancelled', cancelled_at: new Date() }).catch(() => {});
      break;
    }
    default:
      logger.debug(`Unhandled Stripe event: ${event.type}`);
  }
}
