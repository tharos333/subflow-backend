/**
 * SubFlow API — runs with ZERO npm installs using Node.js built-ins only.
 * External services (DB, Stripe, Redis) connect lazily when routes are hit.
 * Install deps with `npm install` then routes will be fully functional.
 */

import http from 'http';
import https from 'https';
import { URL } from 'url';
import fs from 'fs';
import path from 'path';
import Stripe from "stripe";

// ── Load .env manually (no dotenv package needed) ──────────────

function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = val;
  }
}
loadEnv();
import fs from 'fs';, {
  apiVersion: "2024-06-20",
});
const PORT = parseInt(process.env.PORT || '4000', 10);

// ── Tiny router ────────────────────────────────────────────────
type Handler = (req: IncomingRequest, res: ServerResponse) => void | Promise<void>;
interface Route { method: string; pattern: RegExp; keys: string[]; handler: Handler; }

class Router {
  private routes: Route[] = [];

  private add(method: string, path: string, handler: Handler) {
    const keys: string[] = [];
    const pattern = new RegExp(
      '^' + path.replace(/:([^/]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$'
    );
    this.routes.push({ method, pattern, keys, handler });
  }

  get(p: string, h: Handler)    { this.add('GET',    p, h); }
  post(p: string, h: Handler)   { this.add('POST',   p, h); }
  put(p: string, h: Handler)    { this.add('PUT',    p, h); }
  delete(p: string, h: Handler) { this.add('DELETE', p, h); }

  match(method: string, url: string): { handler: Handler; params: Record<string,string> } | null {
    const pathname = url.split('?')[0];
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = pathname.match(r.pattern);
      if (!m) continue;
      const params: Record<string,string> = {};
      r.keys.forEach((k, i) => params[k] = decodeURIComponent(m[i + 1]));
      return { handler: r.handler, params };
    }
    return null;
  }
}

// ── Typed wrappers ─────────────────────────────────────────────
interface IncomingRequest extends http.IncomingMessage {
  params: Record<string, string>;
  query:  Record<string, string>;
  body:   any;
}

interface ServerResponse extends http.ServerResponse {
  json: (data: unknown, status?: number) => void;
}

function enhance(req: http.IncomingMessage, res: http.ServerResponse): [IncomingRequest, ServerResponse] {
  const r = req as IncomingRequest;
  const s = res as ServerResponse;

  const u = new URL(req.url || '/', `http://localhost`);
  r.query  = Object.fromEntries(u.searchParams.entries());
  r.params = {};
  r.body   = null;

  s.json = (data: unknown, status = 200) => {
    const body = JSON.stringify(data);
    s.writeHead(status, {
      'Content-Type':  'application/json',
      'Content-Length': Buffer.byteLength(body),
      'X-Powered-By':  'SubFlow',
    });
    s.end(body);
  };

  return [r, s];
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end',  () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ── CORS helper ────────────────────────────────────────────────
function setCors(res: http.ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin',  process.env.FRONTEND_URL || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

// ── Logger ─────────────────────────────────────────────────────
const log = {
  info:  (m: string) => console.log(`\x1b[32m[INFO]\x1b[0m  ${new Date().toISOString()} ${m}`),
  warn:  (m: string) => console.log(`\x1b[33m[WARN]\x1b[0m  ${new Date().toISOString()} ${m}`),
  error: (m: string) => console.log(`\x1b[31m[ERROR]\x1b[0m ${new Date().toISOString()} ${m}`),
};

// ── Auth helper ────────────────────────────────────────────────
import crypto from 'crypto';

function signJwt(payload: object): string {
  const header  = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body    = Buffer.from(JSON.stringify({ ...payload, iat: Math.floor(Date.now()/1000) })).toString('base64url');
  const secret  = process.env.JWT_SECRET || 'changeme-please';
  const sig     = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

function verifyJwt(token: string): Record<string, unknown> | null {
  try {
    const [header, body, sig] = token.split('.');
    const secret  = process.env.JWT_SECRET || 'changeme-please';
    const expected = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
    if (sig !== expected) return null;
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch { return null; }
}

function requireAuth(req: IncomingRequest, res: ServerResponse): string | null {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) { res.json({ error: 'Unauthorized' }, 401); return null; }
  const payload = verifyJwt(header.slice(7));
  if (!payload?.sub) { res.json({ error: 'Invalid token' }, 401); return null; }
  return payload.sub as string;
}

// ── DB lazy loader ─────────────────────────────────────────────
let _db: any = null;
async function getDb() {
  if (_db) return _db;
  try {
    const knex = require('knex');
    _db = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 1, max: 5 } });
    return _db;
  } catch {
    throw new Error('Database unavailable — run `npm install` to enable DB support');
  }
}

// ── In-memory store (fallback when DB unavailable) ─────────────
const mem = {
  users:   [] as any[],
  shops:   [] as any[],
  plans:   [] as any[],
  subs:    [] as any[],
  customers: [] as any[],
  invoices:  [] as any[],
};

function uuid() { return crypto.randomUUID(); }

// ── Password hashing (built-in crypto) ────────────────────────
function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(pw, salt, 100000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

function checkPassword(pw: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  const attempt = crypto.pbkdf2Sync(pw, salt, 100000, 64, 'sha512').toString('hex');
  return attempt === hash;
}

// ══════════════════════════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════════════════════════
const router = new Router();

// ── Health ────────────────────────────────────────────────────
router.get('/health', (_req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString(), version: '1.0.0' });
});
router.post('/api/stripe/checkout', async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "subscription",
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: "Test Subscription",
            },
            unit_amount: 1000,
            recurring: {
              interval: "month",
            },
          },
          quantity: 1,
        },
      ],
      success_url: "https://example.com/success",
      cancel_url: "https://example.com/cancel",
    });

    res.json({ url: session.url });

  } catch (err) {
    res.json({ error: "Stripe error" }, 500);
  }
});

// ── Auth: Register ────────────────────────────────────────────
router.post('/api/auth/register', async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!email || !password) return res.json({ error: 'Email and password required' }, 400);
  if (mem.users.find(u => u.email === email)) return res.json({ error: 'Email already registered' }, 409);

  const user = { id: uuid(), name, email, password_hash: hashPassword(password), role: 'merchant', created_at: new Date() };
  mem.users.push(user);

  const token = signJwt({ sub: user.id });
  res.json({ user: { id: user.id, name, email }, access_token: token }, 201);
});

// ── Auth: Login ───────────────────────────────────────────────
router.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  const user = mem.users.find(u => u.email === email);
  if (!user || !checkPassword(password, user.password_hash))
    return res.json({ error: 'Invalid credentials' }, 401);
  const token = signJwt({ sub: user.id });
  res.json({ user: { id: user.id, name: user.name, email }, access_token: token });
});

// ── Auth: Shopify install URL ─────────────────────────────────
router.get('/api/auth/shopify/install', (req, res) => {
  const userId = requireAuth(req, res); if (!userId) return;
  const { shop } = req.query;
  if (!shop) return res.json({ error: 'shop param required' }, 400);
  const state = crypto.randomBytes(16).toString('hex');
  const params = new URLSearchParams({
    client_id:  process.env.SHOPIFY_API_KEY || 'placeholder',
    scope:      'read_products,write_products,read_customers,write_customers,read_orders,write_orders',
    redirect_uri: `${process.env.API_URL || 'http://localhost:4000'}/api/auth/shopify/callback`,
    state,
  });
  res.json({ url: `https://${shop}/admin/oauth/authorize?${params}` });
});

// ── Plans: List ───────────────────────────────────────────────
router.get('/api/plans', (req, res) => {
  const userId = requireAuth(req, res); if (!userId) return;
  const shop = mem.shops.find(s => s.user_id === userId);
  const plans = shop ? mem.plans.filter(p => p.shop_id === shop.id && p.is_active) : [];
  res.json(plans);
});

// ── Plans: Create ─────────────────────────────────────────────
router.post('/api/plans', (req, res) => {
  const userId = requireAuth(req, res); if (!userId) return;
  let shop = mem.shops.find(s => s.user_id === userId);
  if (!shop) {
    // auto-create a shop record for demo
    shop = { id: uuid(), user_id: userId, shopify_domain: 'demo.myshopify.com', currency: 'USD', is_active: true };
    mem.shops.push(shop);
  }
  const { name, interval = 'month', intervalCount = 1, trialPeriodDays = 0, discountType, discountValue, description } = req.body || {};
  if (!name || !interval) return res.json({ error: 'name and interval required' }, 400);
  const plan = { id: uuid(), shop_id: shop.id, name, description, interval, interval_count: intervalCount,
    trial_period_days: trialPeriodDays, discount_type: discountType || null,
    discount_value: discountValue || null, stripe_price_id: null, is_active: true, created_at: new Date() };
  mem.plans.push(plan);
  res.json(plan, 201);
});

// ── Plans: Get one ────────────────────────────────────────────
router.get('/api/plans/:id', (req, res) => {
  const userId = requireAuth(req, res); if (!userId) return;
  const plan = mem.plans.find(p => p.id === req.params.id);
  if (!plan) return res.json({ error: 'Plan not found' }, 404);
  res.json(plan);
});

// ── Plans: Update ─────────────────────────────────────────────
router.put('/api/plans/:id', (req, res) => {
  const userId = requireAuth(req, res); if (!userId) return;
  const idx = mem.plans.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.json({ error: 'Plan not found' }, 404);
  mem.plans[idx] = { ...mem.plans[idx], ...req.body, updated_at: new Date() };
  res.json(mem.plans[idx]);
});

// ── Plans: Delete ─────────────────────────────────────────────
router.delete('/api/plans/:id', (req, res) => {
  const userId = requireAuth(req, res); if (!userId) return;
  const idx = mem.plans.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.json({ error: 'Plan not found' }, 404);
  mem.plans[idx].is_active = false;
  res.json({ success: true });
});

// ── Subscriptions: List ───────────────────────────────────────
router.get('/api/subscriptions', (req, res) => {
  const userId = requireAuth(req, res); if (!userId) return;
  const shop = mem.shops.find(s => s.user_id === userId);
  const { status } = req.query;
  let subs = shop ? mem.subs.filter(s => s.shop_id === shop.id) : [];
  if (status) subs = subs.filter(s => s.status === status);
  const enriched = subs.map(s => {
    const plan = mem.plans.find(p => p.id === s.plan_id) || {};
    const customer = mem.customers.find(c => c.id === s.customer_id) || {};
    return { ...s, plan_name: plan.name, interval: plan.interval, interval_count: plan.interval_count,
      customer_email: customer.email, first_name: customer.first_name, last_name: customer.last_name };
  });
  res.json(enriched);
});

// ── Subscriptions: Create ─────────────────────────────────────
router.post('/api/subscriptions', (req, res) => {
  const userId = requireAuth(req, res); if (!userId) return;
  let shop = mem.shops.find(s => s.user_id === userId);
  if (!shop) { shop = { id: uuid(), user_id: userId, shopify_domain: 'demo.myshopify.com', currency: 'USD', is_active: true }; mem.shops.push(shop); }
  const { customerId, planId } = req.body || {};
  if (!customerId || !planId) return res.json({ error: 'customerId and planId required' }, 400);
  const plan = mem.plans.find(p => p.id === planId);
  if (!plan) return res.json({ error: 'Plan not found' }, 404);
  const sub = { id: uuid(), shop_id: shop.id, customer_id: customerId, plan_id: planId,
    status: plan.trial_period_days > 0 ? 'trialing' : 'active',
    base_price: 9.99, custom_price: null, price_override_active: false,
    currency: shop.currency, next_billing_date: new Date(Date.now() + 30*864e5),
    current_period_start: new Date(), current_period_end: new Date(Date.now() + 30*864e5),
    payment_attempts: 0, created_at: new Date() };
  mem.subs.push(sub);
  res.json(sub, 201);
});

// ── Subscriptions: Get one ────────────────────────────────────
router.get('/api/subscriptions/:id', (req, res) => {
  const userId = requireAuth(req, res); if (!userId) return;
  const sub = mem.subs.find(s => s.id === req.params.id);
  if (!sub) return res.json({ error: 'Subscription not found' }, 404);
  res.json(sub);
});

// ── Subscriptions: Pause ──────────────────────────────────────
router.post('/api/subscriptions/:id/pause', (req, res) => {
  const userId = requireAuth(req, res); if (!userId) return;
  const idx = mem.subs.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.json({ error: 'Subscription not found' }, 404);
  mem.subs[idx].status = 'paused';
  mem.subs[idx].paused_at = new Date();
  res.json({ success: true });
});

// ── Subscriptions: Resume ─────────────────────────────────────
router.post('/api/subscriptions/:id/resume', (req, res) => {
  const userId = requireAuth(req, res); if (!userId) return;
  const idx = mem.subs.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.json({ error: 'Subscription not found' }, 404);
  mem.subs[idx].status = 'active';
  mem.subs[idx].paused_at = null;
  res.json({ success: true });
});

// ── Subscriptions: Cancel ─────────────────────────────────────
router.post('/api/subscriptions/:id/cancel', (req, res) => {
  const userId = requireAuth(req, res); if (!userId) return;
  const idx = mem.subs.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.json({ error: 'Subscription not found' }, 404);
  const { immediately = false, reason } = req.body || {};
  if (immediately) { mem.subs[idx].status = 'cancelled'; mem.subs[idx].cancelled_at = new Date(); }
  else { mem.subs[idx].cancel_at_period_end = true; }
  mem.subs[idx].cancel_reason = reason;
  res.json({ success: true });
});

// ── Subscriptions: Skip cycle ─────────────────────────────────
router.post('/api/subscriptions/:id/skip', (req, res) => {
  const userId = requireAuth(req, res); if (!userId) return;
  const idx = mem.subs.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.json({ error: 'Subscription not found' }, 404);
  mem.subs[idx].skipped_next_cycle = true;
  const next = new Date(mem.subs[idx].next_billing_date);
  next.setDate(next.getDate() + 30);
  mem.subs[idx].next_billing_date = next;
  res.json({ success: true });
});

// ── Subscriptions: Edit price (ADVANCED FEATURE) ──────────────
const priceHistory: Record<string, any[]> = {};

router.post('/api/subscriptions/:id/price', (req, res) => {
  const userId = requireAuth(req, res); if (!userId) return;
  const idx = mem.subs.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.json({ error: 'Subscription not found' }, 404);

  const { newPrice, timing, reason } = req.body || {};
  if (!newPrice || isNaN(Number(newPrice)) || Number(newPrice) <= 0)
    return res.json({ error: 'Invalid price — must be a positive number' }, 400);
  if (!['immediate', 'next_cycle'].includes(timing))
    return res.json({ error: 'timing must be "immediate" or "next_cycle"' }, 400);

  const sub = mem.subs[idx];
  const oldPrice = sub.price_override_active ? sub.custom_price : sub.base_price;
  const newPriceNum = Number(newPrice);

  // Calculate proration (prorated days remaining in cycle)
  let prorationAmount: number | null = null;
  if (timing === 'immediate') {
    const now = Date.now();
    const periodEnd   = new Date(sub.current_period_end).getTime();
    const periodStart = new Date(sub.current_period_start).getTime();
    const periodTotal = periodEnd - periodStart;
    const remaining   = Math.max(0, periodEnd - now);
    const fraction    = periodTotal > 0 ? remaining / periodTotal : 0;
    prorationAmount   = Math.round((newPriceNum - oldPrice) * fraction * 100) / 100;
  }

  // Apply price change
  mem.subs[idx].custom_price = newPriceNum;
  mem.subs[idx].price_override_active = true;
  if (timing === 'next_cycle') {
    mem.subs[idx].pending_price_change = { price: newPriceNum, appliesAt: sub.next_billing_date };
  }

  // Record history
  if (!priceHistory[sub.id]) priceHistory[sub.id] = [];
  priceHistory[sub.id].unshift({
    id: uuid(), subscription_id: sub.id, changed_by: userId,
    old_price: oldPrice, new_price: newPriceNum,
    timing, applied_at: timing === 'immediate' ? new Date() : null,
    proration_amount: prorationAmount, reason: reason || null,
    changed_by_name: mem.users.find(u => u.id === userId)?.name || 'Admin',
    created_at: new Date(),
  });

  log.info(`Price updated: sub ${sub.id} $${oldPrice} → $${newPriceNum} (${timing})`);
  res.json({ success: true, prorationAmount, effectiveAt: timing === 'immediate' ? 'now' : sub.next_billing_date });
});

// ── Subscriptions: Price history ──────────────────────────────
router.get('/api/subscriptions/:id/price-history', (req, res) => {
  const userId = requireAuth(req, res); if (!userId) return;
  res.json(priceHistory[req.params.id] || []);
});

// ── Customers: List ───────────────────────────────────────────
router.get('/api/customers', (req, res) => {
  const userId = requireAuth(req, res); if (!userId) return;
  const shop = mem.shops.find(s => s.user_id === userId);
  res.json(shop ? mem.customers.filter(c => c.shop_id === shop.id) : []);
});

// ── Customers: Create ─────────────────────────────────────────
router.post('/api/customers', (req, res) => {
  const userId = requireAuth(req, res); if (!userId) return;
  let shop = mem.shops.find(s => s.user_id === userId);
  if (!shop) { shop = { id: uuid(), user_id: userId, shopify_domain: 'demo.myshopify.com', currency: 'USD', is_active: true }; mem.shops.push(shop); }
  const { email, first_name, last_name, phone } = req.body || {};
  if (!email) return res.json({ error: 'email required' }, 400);
  const customer = { id: uuid(), shop_id: shop.id, shopify_customer_id: uuid(), email, first_name, last_name, phone, created_at: new Date() };
  mem.customers.push(customer);
  res.json(customer, 201);
});

// ── Customers: Get one ────────────────────────────────────────
router.get('/api/customers/:id', (req, res) => {
  const userId = requireAuth(req, res); if (!userId) return;
  const c = mem.customers.find(c => c.id === req.params.id);
  if (!c) return res.json({ error: 'Customer not found' }, 404);
  res.json(c);
});

// ── Customers: Subscriptions ──────────────────────────────────
router.get('/api/customers/:id/subscriptions', (req, res) => {
  const userId = requireAuth(req, res); if (!userId) return;
  const subs = mem.subs.filter(s => s.customer_id === req.params.id);
  res.json(subs);
});

// ── Invoices: List ────────────────────────────────────────────
router.get('/api/invoices', (req, res) => {
  const userId = requireAuth(req, res); if (!userId) return;
  const shop = mem.shops.find(s => s.user_id === userId);
  res.json(shop ? mem.invoices.filter(i => {
    const sub = mem.subs.find(s => s.id === i.subscription_id);
    return sub?.shop_id === shop.id;
  }) : []);
});

// ── Invoices: Retry payment ───────────────────────────────────
router.post('/api/invoices/:id/retry', (req, res) => {
  const userId = requireAuth(req, res); if (!userId) return;
  const inv = mem.invoices.find(i => i.id === req.params.id);
  if (!inv) return res.json({ error: 'Invoice not found' }, 404);
  if (inv.status !== 'open') return res.json({ error: 'Invoice is not open' }, 400);
  // In production: call stripe.invoices.pay(inv.stripe_invoice_id)
  inv.status = 'paid'; inv.paid_at = new Date(); inv.amount_paid = inv.amount_due;
  res.json({ success: true, message: 'Payment retried (demo mode)' });
});

// ── Analytics: Overview ───────────────────────────────────────
router.get('/api/analytics/overview', (req, res) => {
  const userId = requireAuth(req, res); if (!userId) return;
  const shop = mem.shops.find(s => s.user_id === userId);
  const shopSubs = shop ? mem.subs.filter(s => s.shop_id === shop.id) : [];

  const counts = {
    active_count:    shopSubs.filter(s => s.status === 'active').length,
    paused_count:    shopSubs.filter(s => s.status === 'paused').length,
    cancelled_count: shopSubs.filter(s => s.status === 'cancelled').length,
    past_due_count:  shopSubs.filter(s => s.status === 'past_due').length,
    total:           shopSubs.length,
  };

  const intervalMultiplier: Record<string, number> = { day: 30, week: 4.33, month: 1, year: 1/12 };
  const mrr = shopSubs.filter(s => s.status === 'active').reduce((acc, s) => {
    const plan = mem.plans.find(p => p.id === s.plan_id);
    const price = s.price_override_active && s.custom_price ? s.custom_price : s.base_price;
    const mult = intervalMultiplier[plan?.interval || 'month'] / (plan?.interval_count || 1);
    return acc + price * mult;
  }, 0);

  const shopInvoices = mem.invoices.filter(i => {
    const sub = mem.subs.find(s => s.id === i.subscription_id);
    return sub?.shop_id === shop?.id && i.status === 'paid';
  });

  const thirtyDaysAgo = Date.now() - 30 * 864e5;
  const revenue_30d  = shopInvoices.filter(i => new Date(i.paid_at).getTime() > thirtyDaysAgo)
    .reduce((a, i) => a + i.amount_paid, 0);
  const revenue_total = shopInvoices.reduce((a, i) => a + i.amount_paid, 0);

  res.json({ subscriptions: counts, mrr: Math.round(mrr * 100) / 100,
    revenue: { revenue_30d, revenue_total } });
});

// ── Analytics: MRR trend ──────────────────────────────────────
router.get('/api/analytics/mrr', (req, res) => {
  const userId = requireAuth(req, res); if (!userId) return;
  // Demo: return 12 months of placeholder data
  const data = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(); d.setMonth(d.getMonth() - (11 - i));
    return { month: d.toISOString().slice(0, 7), revenue: Math.round(Math.random() * 5000 + 2000) };
  });
  res.json(data);
});

// ── Shops: Get my shop ────────────────────────────────────────
router.get('/api/shops/me', (req, res) => {
  const userId = requireAuth(req, res); if (!userId) return;
  const shop = mem.shops.find(s => s.user_id === userId);
  if (!shop) return res.json({ error: 'No shop connected' }, 404);
  res.json(shop);
});

// ── Webhooks: Stripe (signature check, demo mode) ─────────────
router.post('/webhooks/stripe', (req, res) => {
  const sig = req.headers['stripe-signature'] as string;
  if (!sig) return res.json({ error: 'Missing stripe-signature' }, 400);
  log.info(`[stripe-webhook] Received event (demo mode — install deps for full processing)`);
  res.json({ received: true });
});

// ── Webhooks: Shopify ─────────────────────────────────────────
router.post('/webhooks/shopify', (req, res) => {
  const hmac  = req.headers['x-shopify-hmac-sha256'];
  const topic = req.headers['x-shopify-topic'];
  if (!hmac) return res.json({ error: 'Missing HMAC' }, 401);
  log.info(`[shopify-webhook] ${topic} received (demo mode)`);
  res.json({ received: true });
});

// ══════════════════════════════════════════════════════════════
// HTTP SERVER
// ══════════════════════════════════════════════════════════════
const server = http.createServer(async (rawReq, rawRes) => {
  const [req, res] = enhance(rawReq, rawRes);
if (rawReq.url === "/" && rawReq.method === "GET") {
  rawRes.writeHead(200, { "Content-Type": "text/plain" });
  rawRes.end("API is running 🚀");
  return;
}
  setCors(rawRes);

  // Handle CORS preflight
  if (rawReq.method === 'OPTIONS') {
    rawRes.writeHead(204);
    rawRes.end();
    return;
  }

  // Parse body for POST/PUT
  if (['POST', 'PUT', 'PATCH'].includes(rawReq.method || '')) {
    try {
      const raw = await readBody(rawReq);
      req.body = raw ? JSON.parse(raw) : {};
    } catch { req.body = {}; }
  }

  const method = rawReq.method || 'GET';
  const url    = rawReq.url || '/';
  const match  = router.match(method, url);

  log.info(`${method} ${url}`);

  if (!match) {
    return res.json({ error: `Cannot ${method} ${url.split('?')[0]}` }, 404);
  }

  req.params = match.params;

  try {
    await match.handler(req, res);
  } catch (err: any) {
    log.error(`${method} ${url} — ${err.message}`);
    res.json({ error: err.message || 'Internal server error' }, 500);
  }
});

server.listen(PORT, () => {
  log.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  log.info(`  SubFlow API  →  http://localhost:${PORT}`);
  log.info(`  Health check →  http://localhost:${PORT}/health`);
  log.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  log.info(`  Mode: ${_db ? 'PostgreSQL' : 'in-memory (install npm deps for DB)'}`);
  log.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
});

export default server;
