import { logger } from '../../utils/logger';

export class ShopifySyncService {
  private shop: any;
  constructor(shop: any) { this.shop = shop; }

  async syncProducts(): Promise<void> {
    logger.info(`[sync] syncProducts for ${this.shop.shopify_domain}`);
  }

  async syncCustomers(): Promise<void> {
    logger.info(`[sync] syncCustomers for ${this.shop.shopify_domain}`);
  }
}
