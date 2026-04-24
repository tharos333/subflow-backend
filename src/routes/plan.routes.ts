import { Router, Request, Response, NextFunction } from 'express';
import { db } from '../db/client';
import { authenticate } from '../middleware/auth.middleware';
import { AppError } from '../utils/AppError';

export const planRouter = Router();
planRouter.use(authenticate);

planRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const shop = await db('shops').where({ user_id: req.user!.id }).first();
    if (!shop) return next(new AppError('Shop not found', 404));
    const plans = await db('subscription_plans').where({ shop_id: shop.id, is_active: true });
    res.json(plans);
  } catch (e) { next(e); }
});

planRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const shop = await db('shops').where({ user_id: req.user!.id }).first();
    if (!shop) return next(new AppError('Shop not found', 404));
    const { productIds, ...planData } = req.body;
    const [plan] = await db('subscription_plans').insert({
      shop_id: shop.id,
      name: planData.name,
      description: planData.description,
      interval: planData.interval,
      interval_count: planData.intervalCount || 1,
      trial_period_days: planData.trialPeriodDays || 0,
      discount_type: planData.discountType || null,
      discount_value: planData.discountValue || null,
    }).returning('*');
    if (productIds?.length) {
      await db('plan_products').insert(
        productIds.map((pid: string) => ({ plan_id: plan.id, product_id: pid }))
      );
    }
    res.status(201).json(plan);
  } catch (e) { next(e); }
});

planRouter.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const shop = await db('shops').where({ user_id: req.user!.id }).first();
    const plan = await db('subscription_plans').where({ id: req.params.id, shop_id: shop?.id }).first();
    if (!plan) return next(new AppError('Plan not found', 404));
    res.json(plan);
  } catch (e) { next(e); }
});

planRouter.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const shop = await db('shops').where({ user_id: req.user!.id }).first();
    const [updated] = await db('subscription_plans')
      .where({ id: req.params.id, shop_id: shop?.id })
      .update({ ...req.body, updated_at: new Date() }).returning('*');
    if (!updated) return next(new AppError('Plan not found', 404));
    res.json(updated);
  } catch (e) { next(e); }
});

planRouter.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const shop = await db('shops').where({ user_id: req.user!.id }).first();
    await db('subscription_plans').where({ id: req.params.id, shop_id: shop?.id }).update({ is_active: false });
    res.json({ success: true });
  } catch (e) { next(e); }
});
