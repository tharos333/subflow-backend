import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { db } from '../db/client';
import { AppError } from '../utils/AppError';
import { generateTokens } from '../utils/jwt';
import { authenticate } from '../middleware/auth.middleware';
import { shopifyOAuth } from '../services/shopify/shopifyOAuth.service';
import { syncQueue } from '../jobs/workers';

export const authRouter = Router();

authRouter.post('/register', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, email, password } = req.body;
    if (!email || !password) return next(new AppError('Email and password required', 400));
    const hash = await bcrypt.hash(password, 12);
    const [user] = await db('users').insert({ name, email, password_hash: hash }).returning(['id','name','email']);
    res.status(201).json({ user, ...generateTokens(user.id) });
  } catch (e: any) {
    if (e.code === '23505') return next(new AppError('Email already registered', 409));
    next(e);
  }
});

authRouter.post('/login', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password } = req.body;
    const user = await db('users').where({ email }).first();
    if (!user) return next(new AppError('Invalid credentials', 401));
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return next(new AppError('Invalid credentials', 401));
    res.json({ user: { id: user.id, name: user.name, email: user.email }, ...generateTokens(user.id) });
  } catch (e) { next(e); }
});

authRouter.get('/shopify/install', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { shop } = req.query as { shop: string };
    if (!shop) return next(new AppError('shop param required', 400));
    const state = crypto.randomBytes(16).toString('hex');
    const url = shopifyOAuth.generateInstallUrl(shop, state);
    res.json({ url });
  } catch (e) { next(e); }
});

authRouter.get('/shopify/callback', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { shop, code, state, hmac, ...rest } = req.query as Record<string, string>;
    if (!shopifyOAuth.validateCallback({ shop, code, state, hmac, ...rest }))
      return next(new AppError('OAuth validation failed', 400));
    const accessToken = await shopifyOAuth.exchangeToken(shop, code);
    const shopInfo = await shopifyOAuth.fetchShopInfo(shop, accessToken);
    const shopId = await shopifyOAuth.persistShop(req.user!.id, shop, accessToken, shopInfo);
    await shopifyOAuth.registerWebhooks(shop, accessToken);
    await syncQueue.add('full-sync', { shopId, type: 'full' });
    res.json({ success: true, shopId });
  } catch (e) { next(e); }
});
