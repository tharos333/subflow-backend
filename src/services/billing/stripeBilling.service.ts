/**
 * StripeBillingService
 * All Stripe interactions: create subscriptions, charge invoices,
 * edit prices (with immediate vs next-cycle logic), dunning.
 */
import Stripe from 'stripe';
import { db } from '../../db/client';
import { logger } from '../../utils/logger';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2023-10-16',
  
});

export class StripeBillingService {
  // ── Ensure Stripe Customer exists ─────────────────────────────
  async ensureStripeCustomer(customerId: string): Promise<string> {
    const customer = await db('customers').where({ id: customerId }).first();
    if (customer.stripe_customer_id) return customer.stripe_customer_id;

    const stripeCustomer = await stripe.customers.create({
      email:    customer.email,
      name:     [customer.first_name, customer.last_name].filter(Boolean).join(' '),
      phone:    customer.phone,
      metadata: { subflow_customer_id: customerId },
    });

    await db('customers')
      .where({ id: customerId })
      .update({ stripe_customer_id: stripeCustomer.id });

    return stripeCustomer.id;
  }

  // ── Create Stripe subscription ─────────────────────────────────
  async createSubscription(params: {
    subscriptionId: string;
    customerId:     string;
    priceId:        string;
    trialDays:      number;
    quantity:       number;
    metadata?:      Record<string, string>;
  }): Promise<Stripe.Subscription> {
    const stripeCustomerId = await this.ensureStripeCustomer(params.customerId);

    const sub = await stripe.subscriptions.create({
      customer:  stripeCustomerId,
      items:     [{ price: params.priceId, quantity: params.quantity }],
      trial_period_days: params.trialDays || undefined,
      payment_behavior:  'default_incomplete',
      expand:    ['latest_invoice.payment_intent'],
      metadata:  {
        subflow_subscription_id: params.subscriptionId,
        ...params.metadata,
      },
    });

    await db('subscriptions').where({ id: params.subscriptionId }).update({
      stripe_subscription_id: sub.id,
      status:                 this.mapStripeStatus(sub.status),
      current_period_start:   new Date(sub.current_period_start * 1000),
      current_period_end:     new Date(sub.current_period_end   * 1000),
      next_billing_date:      new Date(sub.current_period_end   * 1000),
    });

    return sub;
  }

  // ── Edit subscription price ────────────────────────────────────
  async editSubscriptionPrice(params: {
    subscriptionId:  string;
    newPrice:        number;         // in cents
    timing:          'immediate' | 'next_cycle';
    changedByUserId: string;
    reason?:         string;
  }): Promise<void> {
    const sub = await db('subscriptions')
      .where({ id: params.subscriptionId })
      .first();

    if (!sub.stripe_subscription_id) throw new Error('No Stripe subscription linked');

    const stripeSub = await stripe.subscriptions.retrieve(sub.stripe_subscription_id);
    const itemId    = stripeSub.items.data[0].id;

    const oldPrice  = Number(sub.custom_price ?? sub.base_price);
    let prorationAmount: number | null = null;

    if (params.timing === 'immediate') {
      // Create a new Stripe Price and swap the item
      const newStripePrice = await stripe.prices.create({
        unit_amount: params.newPrice,
        currency:    sub.currency.toLowerCase(),
        recurring: {
          interval:       stripeSub.items.data[0].price.recurring!.interval,
          interval_count: stripeSub.items.data[0].price.recurring!.interval_count,
        },
        product: stripeSub.items.data[0].price.product as string,
      });

      const updated = await stripe.subscriptions.update(sub.stripe_subscription_id, {
        items: [{ id: itemId, price: newStripePrice.id }],
        proration_behavior: 'create_prorations',
      });

      // Retrieve upcoming invoice to get proration amount
      const upcoming = await stripe.invoices.retrieveUpcoming({
        subscription: sub.stripe_subscription_id,
      });
      prorationAmount = upcoming.amount_due;

      await db('subscriptions').where({ id: params.subscriptionId }).update({
        custom_price:         params.newPrice / 100,
        price_override_active: true,
        stripe_subscription_id: updated.id,
      });
    } else {
      // Schedule the price change for the next billing cycle using Stripe schedule
      const schedule = await stripe.subscriptionSchedules.create({
        from_subscription: sub.stripe_subscription_id,
      });

      const newStripePrice = await stripe.prices.create({
        unit_amount: params.newPrice,
        currency:    sub.currency.toLowerCase(),
        recurring: {
          interval:       stripeSub.items.data[0].price.recurring!.interval,
          interval_count: stripeSub.items.data[0].price.recurring!.interval_count,
        },
        product: stripeSub.items.data[0].price.product as string,
      });

      await stripe.subscriptionSchedules.update(schedule.id, {
        phases: [
          {
            items: [{ price: itemId }],
            end_date: stripeSub.current_period_end,
          },
          {
            items: [{ price: newStripePrice.id }],
            iterations: 1,  // continues indefinitely from this point
          },
        ],
      });

      await db('subscriptions').where({ id: params.subscriptionId }).update({
        custom_price:          params.newPrice / 100,
        price_override_active: true,
      });
    }

    // Record in price change history
    await db('price_change_history').insert({
      subscription_id:  params.subscriptionId,
      changed_by:       params.changedByUserId,
      old_price:        oldPrice,
      new_price:        params.newPrice / 100,
      timing:           params.timing,
      applied_at:       params.timing === 'immediate' ? new Date() : null,
      proration_amount: prorationAmount ? prorationAmount / 100 : null,
      reason:           params.reason,
    });

    logger.info(`Price updated for sub ${params.subscriptionId}: ${oldPrice} → ${params.newPrice / 100} (${params.timing})`);
  }

  // ── Pause subscription ──────────────────────────────────────────
  async pauseSubscription(subscriptionId: string, resumeAt?: Date): Promise<void> {
    const sub = await db('subscriptions').where({ id: subscriptionId }).first();
    await stripe.subscriptions.update(sub.stripe_subscription_id, {
      pause_collection: { behavior: 'void' },
    });
    await db('subscriptions').where({ id: subscriptionId }).update({
      status:           'paused',
      paused_at:        new Date(),
      pause_resumes_at: resumeAt ?? null,
    });
  }

  // ── Resume paused subscription ──────────────────────────────────
  async resumeSubscription(subscriptionId: string): Promise<void> {
    const sub = await db('subscriptions').where({ id: subscriptionId }).first();
    await stripe.subscriptions.update(sub.stripe_subscription_id, {
      pause_collection: '',  // clears the pause
    });
    await db('subscriptions').where({ id: subscriptionId }).update({
      status:           'active',
      paused_at:        null,
      pause_resumes_at: null,
    });
  }

  // ── Cancel subscription ──────────────────────────────────────────
  async cancelSubscription(
    subscriptionId: string,
    opts: { immediately: boolean; reason?: string },
  ): Promise<void> {
    const sub = await db('subscriptions').where({ id: subscriptionId }).first();

    if (opts.immediately) {
      await stripe.subscriptions.cancel(sub.stripe_subscription_id);
      await db('subscriptions').where({ id: subscriptionId }).update({
        status:        'cancelled',
        cancelled_at:  new Date(),
        cancel_reason: opts.reason,
      });
    } else {
      await stripe.subscriptions.update(sub.stripe_subscription_id, {
        cancel_at_period_end: true,
      });
      await db('subscriptions').where({ id: subscriptionId }).update({
        cancel_at_period_end: true,
        cancel_reason:        opts.reason,
      });
    }
  }

  // ── Skip next billing cycle ──────────────────────────────────────
  async skipBillingCycle(subscriptionId: string): Promise<void> {
    const sub = await db('subscriptions').where({ id: subscriptionId }).first();
    const stripeSub = await stripe.subscriptions.retrieve(sub.stripe_subscription_id);
    const nextPeriodEnd = stripeSub.current_period_end + 
      (stripeSub.current_period_end - stripeSub.current_period_start);

    await stripe.subscriptions.update(sub.stripe_subscription_id, {
      trial_end: nextPeriodEnd,
    });
    await db('subscriptions').where({ id: subscriptionId }).update({
      skipped_next_cycle: true,
    });
  }

  // ── Retry failed payment ──────────────────────────────────────────
  async retryFailedPayment(invoiceId: string): Promise<Stripe.Invoice> {
    const invoice = await db('invoices').where({ id: invoiceId }).first();
    const paid = await stripe.invoices.pay(invoice.stripe_invoice_id);
    return paid;
  }

  // ── Map Stripe status to internal status ──────────────────────────
  private mapStripeStatus(status: Stripe.Subscription.Status): string {
    const map: Record<string, string> = {
      active:            'active',
      past_due:          'past_due',
      unpaid:            'unpaid',
      canceled:          'cancelled',
      trialing:          'trialing',
      incomplete:        'past_due',
      incomplete_expired:'expired',
      paused:            'paused',
    };
    return map[status] ?? 'active';
  }

  // ── Verify Stripe webhook signature ──────────────────────────────
  verifyWebhookSignature(rawBody: Buffer, signature: string): Stripe.Event {
    return stripe.webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET!,
    );
  }

  // ── Expose stripe client for repositories ─────────────────────────
  get client() { return stripe; }
}

export const stripeBilling = new StripeBillingService();
