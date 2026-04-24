import { Router, Request, Response, NextFunction } from 'express';
import { db } from '../db/client';
import { authenticate } from '../middleware/auth.middleware';
import { AppError } from '../utils/AppError';
import { stripeBilling } from '../services/billing/stripeBilling.service';

export const invoiceRouter = Router();
invoiceRouter.use(authenticate);

invoiceRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const shop = await db('shops').where({ user_id: req.user!.id }).first();
    if (!shop) return next(new AppError('Shop not found', 404));
    const { page = 1, limit = 20, status } = req.query;
    const query = db('invoices as i')
      .join('customers as c', 'i.customer_id', 'c.id')
      .join('subscriptions as s', 'i.subscription_id', 's.id')
      .where('s.shop_id', shop.id)
      .select('i.*','c.email','c.first_name','c.last_name')
      .orderBy('i.created_at', 'desc')
      .limit(Number(limit)).offset((Number(page) - 1) * Number(limit));
    if (status) query.where('i.status', status as string);
    res.json(await query);
  } catch (e) { next(e); }
});

invoiceRouter.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const shop = await db('shops').where({ user_id: req.user!.id }).first();
    const invoice = await db('invoices as i')
      .join('subscriptions as s', 'i.subscription_id', 's.id')
      .where({ 'i.id': req.params.id, 's.shop_id': shop?.id })
      .select('i.*').first();
    if (!invoice) return next(new AppError('Invoice not found', 404));
    res.json(invoice);
  } catch (e) { next(e); }
});

invoiceRouter.post('/:id/retry', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const shop = await db('shops').where({ user_id: req.user!.id }).first();
    const invoice = await db('invoices as i')
      .join('subscriptions as s', 'i.subscription_id', 's.id')
      .where({ 'i.id': req.params.id, 's.shop_id': shop?.id })
      .select('i.*').first();
    if (!invoice) return next(new AppError('Invoice not found', 404));
    if (invoice.status !== 'open') return next(new AppError('Invoice is not open', 400));
    await stripeBilling.retryFailedPayment(invoice.id);
    res.json({ success: true });
  } catch (e) { next(e); }
});
