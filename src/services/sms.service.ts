import AfricasTalking from 'africastalking';
import { config } from '../config/env';
import { logger } from '../utils/logger';
import { UpstreamServiceError } from '../utils/errors';

/**
 * SMS delivery via Africa's Talking.
 *
 * The class is written for dependency injection: the underlying SMS client is
 * passed in (or lazily built from config), so tests can supply a fake without
 * any network access. A module-level singleton is exported for app use.
 */

/** Minimal contract for the piece of the Africa's Talking SDK we use. */
export interface SmsClient {
  send(options: {
    to: string | string[];
    message: string;
    from?: string;
  }): Promise<unknown>;
}

/** Build the real Africa's Talking SMS client from configuration. */
function createDefaultClient(): SmsClient {
  const at = AfricasTalking({
    apiKey: config.africasTalking.apiKey,
    username: config.africasTalking.username,
  });
  return at.SMS as SmsClient;
}

export class SmsService {
  private readonly client: SmsClient;

  constructor(client: SmsClient = createDefaultClient()) {
    this.client = client;
  }

  /**
   * Send the OTP code to a phone number.
   *
   * @throws {UpstreamServiceError} if the SMS provider rejects the request.
   */
  async sendOtp(phone: string, otp: string): Promise<void> {
    const message = `Your InDeed verification code is ${otp}. It expires in ${config.otp.expiryMinutes} minutes. Do not share it with anyone.`;

    try {
      await this.client.send({
        to: phone,
        message,
        ...(config.africasTalking.senderId ? { from: config.africasTalking.senderId } : {}),
      });
      logger.info('OTP SMS dispatched', { phone: maskPhone(phone) });
    } catch (err) {
      logger.error('Failed to send OTP SMS', {
        phone: maskPhone(phone),
        error: err instanceof Error ? err.message : String(err),
      });
      throw new UpstreamServiceError('Failed to send verification SMS');
    }
  }
}

/** Mask all but the last 3 digits of a phone number for safe logging. */
function maskPhone(phone: string): string {
  return phone.length <= 3 ? '***' : `${'*'.repeat(phone.length - 3)}${phone.slice(-3)}`;
}

/** Shared singleton used by controllers. */
export const smsService = new SmsService();
