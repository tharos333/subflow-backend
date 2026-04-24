import { Router, Request, Response, NextFunction } from 'express';
import { db } from '../db/client';
import { authenticate } from '../middleware/auth.middleware';
import { AppError } from '../utils/AppError';

export const shopRouter = Router();
shopRouter.use(authenticate);

shopRouter.get('/me', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const shop = await db('shops').where({ user_id: req.user!.id, is_active: true }).first();
    if (!shop) return next(new AppError('No shop found', 404));
    const { access_token, ...safe } = shop;
    res.json(safe);
  } catch (e) { next(e); }
});

shopRouter.put('/me', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const shop = await db('shops').where({ user_id: req.user!.id }).first();
    if (!shop) return next(new AppError('No shop found', 404));
    const [updated] = await db('shops').where({ id: shop.id })
      .update({ ...req.body, updated_at: new Date() }).returning('*');
    const { access_token, ...safe } = updated;
    res.json(safe);
  } catch (e) { next(e); }
});
