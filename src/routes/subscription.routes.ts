import { Router, Request, Response, NextFunction } from 'express';
import { db } from '../db/client';
import { authenticate } from '../middleware/auth.middleware';
import { AppError } from '../utils/AppError';
import { stripeBilling } from '../services/billing/stripeBilling.service';

export const subscriptionRouter = Router();
subscriptionRouter.use(authenticate);

async function getShop(userId: string) {
  return db('shops').where({ user_id: userId }).first();
}

subscriptionRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const shop = await getShop(req.user!.id);
    if (!shop) return next(new AppError('Shop not found', 404));
    const { status, page = 1, limit = 20 } = req.query;
    const query = db('subscriptions as s')
      .join('customers as c', 's.customer_id', 'c.id')
      .join('subscription_plans as p', 's.plan_id', 'p.id')
      .where('s.shop_id', shop.id)
      .select('s.id','s.status','s.base_price','s.custom_price','s.price_override_active',
              's.next_billing_date','s.current_period_end','s.created_at',
              'c.email as customer_email','c.first_name','c.last_name',
              'p.name as plan_name','p.interval','p.interval_count')
      .orderBy('s.created_at', 'desc')
      .limit(Number(limit)).offset((Number(page) - 1) * Number(limit));
    if (status) query.where('s.status', status as string);
    res.json(await query);
  } catch (e) { next(e); }
});

subscriptionRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const shop = await getShop(req.user!.id);
    if (!shop) return next(new AppError('Shop not found', 404));
    const { customerId, planId } = req.body;
    const plan = await db('subscription_plans').where({ id: planId, shop_id: shop.id }).first();
    if (!plan) return next(new AppError('Plan not found', 404));
    const [sub] = await db('subscriptions').insert({
      shop_id: shop.id, customer_id: customerId, plan_id: planId,
      status: 'trialing', base_price: plan.discount_value
        ? plan.base_price - plan.discount_value : plan.base_price,
      currency: shop.currency || 'USD',
    }).returning('*');
    if (plan.stripe_price_id) {
      await stripeBilling.createSubscription({
        subscriptionId: sub.id, customerId, priceId: plan.stripe_price_id,
        trialDays: plan.trial_period_days || 0, quantity: 1,
      });
    }
    res.status(201).json(sub);
  } catch (e) { next(e); }
});

subscriptionRouter.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const shop = await getShop(req.user!.id);
    const sub = await db('subscriptions as s')
      .join('customers as c', 's.customer_id', 'c.id')
      .join('subscription_plans as p', 's.plan_id', 'p.id')
      .where({ 's.id': req.params.id, 's.shop_id': shop?.id })
      .select('s.*','c.email','c.first_name','c.last_name','p.name as plan_name').first();
    if (!sub) return next(new AppError('Subscription not found', 404));
    res.json(sub);
  } catch (e) { next(e); }
});

subscriptionRouter.post('/:id/pause', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await stripeBilling.pauseSubscription(req.params.id, req.body.resumeAt);
    res.json({ success: true });
  } catch (e) { next(e); }
});

subscriptionRouter.post('/:id/resume', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await stripeBilling.resumeSubscription(req.params.id);
    res.json({ success: true });
  } catch (e) { next(e); }
});

subscriptionRouter.post('/:id/cancel', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { immediately = false, reason } = req.body;
    await stripeBilling.cancelSubscription(req.params.id, { immediately, reason });
    res.json({ success: true });
  } catch (e) { next(e); }
});

subscriptionRouter.post('/:id/skip', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await stripeBilling.skipBillingCycle(req.params.id);
    res.json({ success: true });
  } catch (e) { next(e); }
});

subscriptionRouter.post('/:id/price', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { newPrice, timing, reason } = req.body;
    if (!newPrice || newPrice <= 0) return next(new AppError('Invalid price', 400));
    if (!['immediate','next_cycle'].includes(timing)) return next(new AppError('Invalid timing', 400));
    const shop = await getShop(req.user!.id);
    const sub = await db('subscriptions').where({ id: req.params.id, shop_id: shop?.id }).first();
    if (!sub) return next(new AppError('Subscription not found', 404));
    await stripeBilling.editSubscriptionPrice({
      subscriptionId: req.params.id,
      newPrice: Math.round(newPrice * 100),
      timing, changedByUserId: req.user!.id, reason,
    });
    res.json({ success: true });
  } catch (e) { next(e); }
});

subscriptionRouter.get('/:id/price-history', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const shop = await getShop(req.user!.id);
    const sub = await db('subscriptions').where({ id: req.params.id, shop_id: shop?.id }).first();
    if (!sub) return next(new AppError('Subscription not found', 404));
    const history = await db('price_change_history as h')
      .leftJoin('users as u', 'h.changed_by', 'u.id')
      .where('h.subscription_id', req.params.id)
      .select('h.*','u.name as changed_by_name').orderBy('h.created_at', 'desc');
    res.json(history);
  } catch (e) { next(e); }
});
