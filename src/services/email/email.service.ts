import { logger } from '../../utils/logger';

interface SendOptions {
  to: string;
  template: string;
  data?: Record<string, any>;
}

class EmailService {
  async send(opts: SendOptions): Promise<void> {
    // Replace with Resend/SendGrid in production
    logger.info(`[email] Sending "${opts.template}" to ${opts.to}`);
  }
}

export const emailService = new EmailService();
