/**
 * ShopifyOAuthService
 * Handles the full Shopify OAuth 2.0 install + callback flow.
 * Stores encrypted access tokens. Registers mandatory webhooks.
 */
import crypto from 'crypto';
import axios from 'axios';
import { db } from '../../db/client';
import { logger } from '../../utils/logger';
import { encrypt } from '../../utils/crypto';

const REQUIRED_SCOPES = [
  'read_products',
  'write_products',
  'read_customers',
  'write_customers',
  'read_orders',
  'write_orders',
].join(',');

const SHOPIFY_WEBHOOKS = [
  { topic: 'orders/create',    address: `${process.env.API_URL}/webhooks/shopify/orders-create` },
  { topic: 'app/uninstalled',  address: `${process.env.API_URL}/webhooks/shopify/app-uninstalled` },
  { topic: 'customers/update', address: `${process.env.API_URL}/webhooks/shopify/customers-update` },
  { topic: 'products/update',  address: `${process.env.API_URL}/webhooks/shopify/products-update` },
];

export class ShopifyOAuthService {
  // ── Step 1: Generate install redirect URL ────────────────────
  generateInstallUrl(shop: string, state: string): string {
    const params = new URLSearchParams({
      client_id:    process.env.SHOPIFY_API_KEY!,
      scope:        REQUIRED_SCOPES,
      redirect_uri: `${process.env.API_URL}/api/auth/shopify/callback`,
      state,
      'grant_options[]': 'per-user',
    });
    return `https://${shop}/admin/oauth/authorize?${params}`;
  }

  // ── Step 2: Validate OAuth callback ─────────────────────────
  validateCallback(query: Record<string, string>): boolean {
    const { hmac, ...rest } = query;
    if (!hmac) return false;

    const sorted = Object.keys(rest)
      .sort()
      .map((k) => `${k}=${rest[k]}`)
      .join('&');

    const calculated = crypto
      .createHmac('sha256', process.env.SHOPIFY_API_SECRET!)
      .update(sorted)
      .digest('hex');

    return crypto.timingSafeEqual(
      Buffer.from(calculated, 'hex'),
      Buffer.from(hmac, 'hex'),
    );
  }

  // ── Step 3: Exchange code for access token ───────────────────
  async exchangeToken(shop: string, code: string): Promise<string> {
    const { data } = await axios.post(
      `https://${shop}/admin/oauth/access_token`,
      {
        client_id:     process.env.SHOPIFY_API_KEY,
        client_secret: process.env.SHOPIFY_API_SECRET,
        code,
      },
    );
    return data.access_token as string;
  }

  // ── Step 4: Fetch shop info ──────────────────────────────────
  async fetchShopInfo(shop: string, accessToken: string) {
    const { data } = await axios.get(
      `https://${shop}/admin/api/2024-01/shop.json`,
      { headers: { 'X-Shopify-Access-Token': accessToken } },
    );
    return data.shop;
  }

  // ── Step 5: Persist shop record ─────────────────────────────
  async persistShop(
    userId: string,
    shop: string,
    accessToken: string,
    shopInfo: Record<string, unknown>,
  ) {
    const encryptedToken = encrypt(accessToken);

    const existing = await db('shops').where({ shopify_domain: shop }).first();
    if (existing) {
      await db('shops').where({ id: existing.id }).update({
        access_token:   encryptedToken,
        is_active:      true,
        uninstalled_at: null,
        updated_at:     db.fn.now(),
        owner_name:     shopInfo.shop_owner as string,
        email:          shopInfo.email as string,
        currency:       shopInfo.currency as string,
        timezone:       shopInfo.iana_timezone as string,
        plan_name:      shopInfo.plan_name as string,
      });
      return existing.id;
    }

    const [newShop] = await db('shops').insert({
      user_id:       userId,
      shopify_domain: shop,
      access_token:  encryptedToken,
      scope:         REQUIRED_SCOPES,
      owner_name:    shopInfo.shop_owner as string,
      email:         shopInfo.email as string,
      currency:      shopInfo.currency as string,
      timezone:      shopInfo.iana_timezone as string,
      plan_name:     shopInfo.plan_name as string,
    }).returning('id');

    return newShop.id;
  }

  // ── Step 6: Register webhooks ────────────────────────────────
  async registerWebhooks(shop: string, accessToken: string): Promise<void> {
    for (const wh of SHOPIFY_WEBHOOKS) {
      try {
        await axios.post(
          `https://${shop}/admin/api/2024-01/webhooks.json`,
          { webhook: { ...wh, format: 'json' } },
          { headers: { 'X-Shopify-Access-Token': accessToken } },
        );
        logger.info(`Webhook registered: ${wh.topic} → ${shop}`);
      } catch (err: unknown) {
        // 422 = already registered — fine
        if ((err as { response?: { status?: number } }).response?.status !== 422) {
          logger.warn(`Failed to register webhook ${wh.topic}: ${(err as Error).message}`);
        }
      }
    }
  }

  // ── Verify Shopify webhook HMAC ──────────────────────────────
  verifyWebhookHmac(rawBody: Buffer, hmacHeader: string): boolean {
    const calculated = crypto
      .createHmac('sha256', process.env.SHOPIFY_WEBHOOK_SECRET!)
      .update(rawBody)
      .digest('base64');
    return crypto.timingSafeEqual(
      Buffer.from(calculated),
      Buffer.from(hmacHeader),
    );
  }
}

export const shopifyOAuth = new ShopifyOAuthService();
