import { Router, Request, Response, NextFunction } from 'express';
import { db } from '../db/client';
import { authenticate } from '../middleware/auth.middleware';
import { AppError } from '../utils/AppError';

export const customerRouter = Router();
customerRouter.use(authenticate);

customerRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const shop = await db('shops').where({ user_id: req.user!.id }).first();
    if (!shop) return next(new AppError('Shop not found', 404));
    const { page = 1, limit = 20 } = req.query;
    const customers = await db('customers').where({ shop_id: shop.id })
      .orderBy('created_at', 'desc')
      .limit(Number(limit)).offset((Number(page) - 1) * Number(limit));
    res.json(customers);
  } catch (e) { next(e); }
});

customerRouter.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const shop = await db('shops').where({ user_id: req.user!.id }).first();
    const customer = await db('customers').where({ id: req.params.id, shop_id: shop?.id }).first();
    if (!customer) return next(new AppError('Customer not found', 404));
    res.json(customer);
  } catch (e) { next(e); }
});

customerRouter.get('/:id/subscriptions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const shop = await db('shops').where({ user_id: req.user!.id }).first();
    const subs = await db('subscriptions as s')
      .join('subscription_plans as p', 's.plan_id', 'p.id')
      .where({ 's.customer_id': req.params.id, 's.shop_id': shop?.id })
      .select('s.*', 'p.name as plan_name');
    res.json(subs);
  } catch (e) { next(e); }
});
