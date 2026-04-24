import { Router, Request, Response } from 'express';
import { shopifyOAuth } from '../services/shopify/shopifyOAuth.service';
import { db } from '../db/client';
import { logger } from '../utils/logger';

export const shopifyWebhookRouter = Router();

shopifyWebhookRouter.post('/:topic', async (req: Request, res: Response) => {
  const hmacHeader = req.headers['x-shopify-hmac-sha256'] as string;
  const shopDomain = req.headers['x-shopify-shop-domain'] as string;
  const topic = req.headers['x-shopify-topic'] as string;

  if (!shopifyOAuth.verifyWebhookHmac(req.body as Buffer, hmacHeader)) {
    logger.warn(`Invalid Shopify HMAC from ${shopDomain}`);
    return res.status(401).json({ error: 'Invalid HMAC' });
  }

  const payload = JSON.parse((req.body as Buffer).toString('utf8'));
  const shop = await db('shops').where({ shopify_domain: shopDomain }).first().catch(() => null);

  await db('webhook_logs').insert({
    source: 'shopify', event_type: topic,
    event_id: req.headers['x-shopify-webhook-id'] as string,
    shop_id: shop?.id ?? null, payload: JSON.stringify(payload),
    status: 'received', attempts: 1,
  }).catch(() => {});

  try {
    await processShopifyEvent(topic, payload, shop);
  } catch (err) {
    logger.error(`Shopify webhook ${topic} failed: ${(err as Error).message}`);
  }
  res.status(200).send('OK');
});

async function processShopifyEvent(topic: string, payload: any, shop: any) {
  switch (topic) {
    case 'app/uninstalled':
      if (!shop) break;
      await db('shops').where({ id: shop.id }).update({ is_active: false, uninstalled_at: new Date() });
      await db('subscriptions').where({ shop_id: shop.id, status: 'active' })
        .update({ status: 'cancelled', cancelled_at: new Date(), cancel_reason: 'app_uninstalled' });
      logger.info(`App uninstalled from ${shop.shopify_domain}`);
      break;
    case 'orders/create':
      if (!shop || !payload.customer?.id) break;
      const customer = await db('customers')
        .where({ shop_id: shop.id, shopify_customer_id: String(payload.customer.id) }).first();
      if (customer) {
        const sub = await db('subscriptions').where({ customer_id: customer.id, status: 'active' })
          .orderBy('created_at', 'desc').first();
        if (sub) await db('subscriptions').where({ id: sub.id }).update({ shopify_order_id: String(payload.id) });
      }
      break;
    default:
      logger.debug(`Unhandled Shopify topic: ${topic}`);
  }
}
