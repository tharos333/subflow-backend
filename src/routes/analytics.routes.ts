import { Router, Request, Response, NextFunction } from 'express';
import { db } from '../db/client';
import { authenticate } from '../middleware/auth.middleware';
import { AppError } from '../utils/AppError';

export const analyticsRouter = Router();
analyticsRouter.use(authenticate);

analyticsRouter.get('/overview', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const shop = await db('shops').where({ user_id: req.user!.id }).first();
    if (!shop) return next(new AppError('Shop not found', 404));

    const counts = await db('subscriptions').where({ shop_id: shop.id })
      .select(
        db.raw("COUNT(*) FILTER (WHERE status = 'active') as active_count"),
        db.raw("COUNT(*) FILTER (WHERE status = 'paused') as paused_count"),
        db.raw("COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled_count"),
        db.raw("COUNT(*) FILTER (WHERE status = 'past_due') as past_due_count"),
      ).first();

    const revenue = await db('invoices as i')
      .join('subscriptions as s', 'i.subscription_id', 's.id')
      .where({ 's.shop_id': shop.id, 'i.status': 'paid' })
      .select(
        db.raw("SUM(i.amount_paid) FILTER (WHERE i.paid_at > NOW() - INTERVAL '30 days') as revenue_30d"),
        db.raw("SUM(i.amount_paid) as revenue_total"),
      ).first();

    const subs = await db('subscriptions as s')
      .join('subscription_plans as p', 's.plan_id', 'p.id')
      .where({ 's.shop_id': shop.id, 's.status': 'active' })
      .select('s.base_price','s.custom_price','s.price_override_active','p.interval','p.interval_count');

    const mrr = subs.reduce((acc: number, s: any) => {
      const price = s.price_override_active && s.custom_price ? Number(s.custom_price) : Number(s.base_price);
      const m: Record<string, number> = { day: 30, week: 4.33, month: 1, year: 1/12 };
      return acc + price * (m[s.interval] || 1) / (Number(s.interval_count) || 1);
    }, 0);

    res.json({ subscriptions: counts, mrr: Math.round(mrr * 100) / 100, revenue });
  } catch (e) { next(e); }
});

analyticsRouter.get('/mrr', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const shop = await db('shops').where({ user_id: req.user!.id }).first();
    if (!shop) return next(new AppError('Shop not found', 404));
    // Last 12 months MRR from paid invoices
    const data = await db('invoices as i')
      .join('subscriptions as s', 'i.subscription_id', 's.id')
      .where('s.shop_id', shop.id).where('i.status', 'paid')
      .where('i.paid_at', '>=', db.raw("NOW() - INTERVAL '12 months'"))
      .select(db.raw("DATE_TRUNC('month', i.paid_at) as month, SUM(i.amount_paid) as revenue"))
      .groupByRaw("DATE_TRUNC('month', i.paid_at)").orderBy('month');
    res.json(data);
  } catch (e) { next(e); }
});
