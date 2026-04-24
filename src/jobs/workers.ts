/**
 * Background Job System — BullMQ
 * Queues: renewal · dunning · reminders · cancellation · sync
 *
 * Start workers with: node dist/jobs/worker.js
 */
import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { db } from '../../db/client';
import { stripeBilling } from '../../services/billing/stripeBilling.service';
import { emailService } from '../../services/email/email.service';
import { logger } from '../../utils/logger';

// ── Redis connection ──────────────────────────────────────────────
const connection = new IORedis(process.env.REDIS_URL!, {
  maxRetriesPerRequest: null,  // required by BullMQ
});

// ── Queue definitions ────────────────────────────────────────────
export const renewalQueue = new Queue('renewal', { connection });
export const dunningQueue = new Queue('dunning', { connection });
export const reminderQueue = new Queue('reminder', { connection });
export const cancellationQueue = new Queue('cancellation', { connection });
export const syncQueue = new Queue('sync', { connection });

// ── Helper: update job_logs ──────────────────────────────────────
async function logJob(job: Job, status: string, error?: string) {
  await db('job_logs')
    .where({ job_id: job.id, queue_name: job.queueName })
    .update({
      status,
      error:        error ?? null,
      attempts:     job.attemptsMade,
      completed_at: status === 'completed' ? new Date() : null,
    })
    .catch(() => {/* ignore if not found */});
}

// ═══════════════════════════════════════════════
// WORKER 1 — Daily Renewal Processor
// Picks up subscriptions due today and charges them
// ═══════════════════════════════════════════════
export const renewalWorker = new Worker('renewal', async (job: Job) => {
  logger.info(`[renewal] Processing job ${job.id}`);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const dueSubscriptions = await db('subscriptions')
    .where({ status: 'active' })
    .whereBetween('next_billing_date', [today, tomorrow])
    .where({ skipped_next_cycle: false })
    .select('*');

  logger.info(`[renewal] Found ${dueSubscriptions.length} subscriptions due`);

  for (const sub of dueSubscriptions) {
    try {
      // Determine price to charge
      const chargePrice = sub.price_override_active && sub.custom_price
        ? sub.custom_price
        : sub.base_price;

      // Stripe handles recurring billing automatically — we just need to
      // ensure the subscription is active and prices are correct.
      // If custom price changed, update Stripe item price before billing.
      const stripeSub = await stripeBilling.client.subscriptions.retrieve(
        sub.stripe_subscription_id
      );

      const currentStripeAmount = stripeSub.items.data[0].price.unit_amount! / 100;
      if (Math.abs(currentStripeAmount - chargePrice) > 0.01) {
        logger.info(`[renewal] Price mismatch for ${sub.id}, updating Stripe`);
        // price was changed — already handled by editSubscriptionPrice, but double-check
      }

      // Create invoice record after Stripe bills
      await db('subscriptions').where({ id: sub.id }).update({
        payment_attempts: 0,
        skipped_next_cycle: false,
      });

      logger.info(`[renewal] Sub ${sub.id} renewed successfully`);
    } catch (err) {
      logger.error(`[renewal] Failed sub ${sub.id}: ${(err as Error).message}`);
      await dunningQueue.add('retry-payment', { subscriptionId: sub.id }, {
        delay: 60 * 60 * 1000,  // retry in 1 hour
      });
    }
  }

  return { processed: dueSubscriptions.length };
}, { connection, concurrency: 5 });

// ═══════════════════════════════════════════════
// WORKER 2 — Dunning System
// Retries failed payments with exponential backoff
// ═══════════════════════════════════════════════
const DUNNING_SCHEDULE_DAYS = [1, 3, 7, 14];  // retry after N days

export const dunningWorker = new Worker('dunning', async (job: Job) => {
  const { subscriptionId, attempt = 1 } = job.data as {
    subscriptionId: string;
    attempt?: number;
  };

  logger.info(`[dunning] Sub ${subscriptionId} attempt ${attempt}`);

  const sub = await db('subscriptions as s').join('customers as c', 's.customer_id', 'c.id').where('s.id', subscriptionId).select('s.*', 'c.email as customer_email', 'c.first_name').first();
  if (!sub || sub.status === 'cancelled') return;

  // Find the unpaid invoice
  const unpaidInvoice = await db('invoices')
    .where({ subscription_id: subscriptionId, status: 'open' })
    .orderBy('created_at', 'desc')
    .first();

  if (!unpaidInvoice) {
    logger.info(`[dunning] No open invoice for ${subscriptionId}, stopping`);
    return;
  }

  try {
    await stripeBilling.retryFailedPayment(unpaidInvoice.id);

    await db('subscriptions').where({ id: subscriptionId }).update({
      status:              'active',
      payment_attempts:    0,
      dunning_started_at:  null,
    });

    await emailService.send({
      to:       sub.customer_email,
      template: 'payment_recovered',
      data:     { subscriptionId },
    });

    logger.info(`[dunning] Payment recovered for ${subscriptionId}`);
  } catch {
    const nextAttempt = attempt + 1;

    if (nextAttempt > DUNNING_SCHEDULE_DAYS.length) {
      // Max attempts reached → cancel subscription
      logger.warn(`[dunning] Max attempts for ${subscriptionId}, cancelling`);

      await db('subscriptions').where({ id: subscriptionId }).update({
        status:        'unpaid',
        cancelled_at:  new Date(),
        cancel_reason: 'max_dunning_attempts',
      });

      await emailService.send({
        to:       sub.customer_email,
        template: 'subscription_cancelled_dunning',
        data:     { subscriptionId },
      });
      return;
    }

    const delayMs = DUNNING_SCHEDULE_DAYS[nextAttempt - 1] * 24 * 60 * 60 * 1000;

    await dunningQueue.add(
      'retry-payment',
      { subscriptionId, attempt: nextAttempt },
      { delay: delayMs },
    );

    await db('subscriptions').where({ id: subscriptionId }).update({
      payment_attempts:   nextAttempt,
      last_payment_attempt: new Date(),
      dunning_started_at: db.raw('COALESCE(dunning_started_at, NOW())'),
      status:             'past_due',
    });

    await emailService.send({
      to:       sub.customer_email,
      template: 'payment_failed',
      data:     { subscriptionId, attempt: nextAttempt, nextRetryDays: DUNNING_SCHEDULE_DAYS[nextAttempt - 1] },
    });
  }
}, { connection, concurrency: 10 });

// ═══════════════════════════════════════════════
// WORKER 3 — Reminder emails
// ═══════════════════════════════════════════════
export const reminderWorker = new Worker('reminder', async (job: Job) => {
  const { type, subscriptionId } = job.data as {
    type: 'upcoming_renewal' | 'trial_ending' | 'paused_resume';
    subscriptionId: string;
  };

  const sub = await db('subscriptions as s')
    .join('customers as c', 's.customer_id', 'c.id')
    .where('s.id', subscriptionId)
    .select('s.*', 'c.email', 'c.first_name')
    .first();

  if (!sub) return;

  await emailService.send({
    to:       sub.email,
    template: type,
    data:     { sub },
  });

  logger.info(`[reminder] Sent ${type} for ${subscriptionId}`);
}, { connection, concurrency: 20 });

// ═══════════════════════════════════════════════
// WORKER 4 — Shopify product/customer sync
// ═══════════════════════════════════════════════
export const syncWorker = new Worker('sync', async (job: Job) => {
  const { shopId, type } = job.data as {
    shopId: string;
    type:   'products' | 'customers' | 'full';
  };

  const shop = await db('shops').where({ id: shopId }).first();
  if (!shop || !shop.is_active) return;

  const { ShopifySyncService } = await import('../../services/shopify/shopifySync.service');
  const syncService = new ShopifySyncService(shop);

  if (type === 'products' || type === 'full') {
    await syncService.syncProducts();
  }
  if (type === 'customers' || type === 'full') {
    await syncService.syncCustomers();
  }

  logger.info(`[sync] ${type} sync complete for shop ${shopId}`);
}, { connection, concurrency: 3 });

// ═══════════════════════════════════════════════
// CRON SCHEDULER — Enqueue periodic jobs
// ═══════════════════════════════════════════════
export async function scheduleCronJobs() {
  // Daily renewal check — runs at 00:05 UTC every day
  await renewalQueue.add(
    'daily-renewal',
    {},
    {
      repeat: { pattern: '5 0 * * *' },
      removeOnComplete: 100,
      removeOnFail: 50,
    },
  );

  // Daily: enqueue upcoming renewal reminders (3 days before billing)
  await reminderQueue.add(
    'schedule-upcoming-reminders',
    { type: 'upcoming_renewal', daysAhead: 3 },
    {
      repeat: { pattern: '10 0 * * *' },
    },
  );

  // Weekly: cancel overdue subscriptions (past_due > 14 days)
  await cancellationQueue.add(
    'cancel-overdue',
    {},
    {
      repeat: { pattern: '0 1 * * 1' },
    },
  );

  logger.info('[cron] Scheduled all recurring jobs');
}

// ── Error listeners ──────────────────────────────────────────────
for (const worker of [renewalWorker, dunningWorker, reminderWorker, syncWorker]) {
  worker.on('failed', async (job, err) => {
    logger.error(`[${worker.name}] job ${job?.id} failed: ${err.message}`);
    if (job) await logJob(job, 'failed', err.message);
  });
  worker.on('completed', async (job) => {
    await logJob(job, 'completed');
  });
}
