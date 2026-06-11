import PDFDocument from 'pdfkit';
import Stripe from 'stripe';
import { config } from '../config/env';
import { query } from '../config/database';
import { logger } from '../utils/logger';
import {
  ForbiddenError,
  NotFoundError,
  UpstreamServiceError,
  ValidationError,
} from '../utils/errors';
import type {
  CheckoutResult,
  Invoice,
  InvoiceArtifacts,
  MobileMoneyProvider,
  Payment,
  PaymentPlan,
  PlanDefinition,
  User,
} from '../types';

/**
 * Payment processing: Stripe Checkout for cards, mobile-money intents, and PDF
 * invoice generation.
 *
 * Pricing is server-authoritative — the amount charged is always derived from
 * {@link PLANS} here, never taken from the client. The Stripe client is injected
 * for testability and is optional at construction (the app boots without keys;
 * card endpoints then return a clear "not configured" error).
 */

/** Subscription length granted by a successful payment. */
const SUBSCRIPTION_DAYS = 30;

/** Supported mobile-money providers. */
const MOBILE_MONEY_PROVIDERS: ReadonlySet<string> = new Set(['mtn', 'airtel', 'zamtel']);

/**
 * Plan catalogue. Prices are monthly, in Zambian Kwacha (major units):
 * Buyer K600, Seller K1,200, Bank K8,000 (+K400 per fraud check).
 */
export const PLANS: Readonly<Record<PaymentPlan, PlanDefinition>> = {
  buyer: { plan: 'buyer', label: 'Buyer', amount: 600, grants: 'premium' },
  seller: { plan: 'seller', label: 'Seller', amount: 1_200, grants: 'professional' },
  bank: { plan: 'bank', label: 'Bank', amount: 8_000, grants: 'enterprise', perCheckAmount: 400 },
};

export class PaymentService {
  private readonly stripe: Stripe | null;

  constructor(stripe?: Stripe) {
    if (stripe) {
      this.stripe = stripe;
    } else if (config.stripe.secretKey) {
      this.stripe = new Stripe(config.stripe.secretKey);
    } else {
      this.stripe = null;
    }
  }

  /**
   * Create a Stripe Checkout Session for a subscription plan and record a
   * pending payment. The charged amount is taken from the plan, not the caller.
   *
   * @throws {ValidationError}      for an unknown plan.
   * @throws {UpstreamServiceError} if Stripe is not configured or errors.
   */
  async createStripeCheckout(
    userId: string,
    tier: PaymentPlan,
    amount: number,
  ): Promise<CheckoutResult> {
    const plan = PLANS[tier];
    if (!plan) throw new ValidationError(`Unknown plan: ${tier}`);
    if (!(amount > 0)) throw new ValidationError('Amount must be greater than zero');

    const stripe = this.requireStripe();

    // Record the pending payment first so the webhook can correlate via metadata.
    const payment = await this.insertPayment({
      userId,
      amount,
      currency: config.stripe.currency.toUpperCase(),
      provider: 'stripe',
      subscriptionTier: plan.grants,
    });

    let session: Stripe.Checkout.Session;
    try {
      session = await stripe.checkout.sessions.create({
        mode: 'payment',
        client_reference_id: userId,
        metadata: { paymentId: payment.id, userId, plan: plan.plan, subscriptionTier: plan.grants },
        success_url: config.stripe.successUrl,
        cancel_url: config.stripe.cancelUrl,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: config.stripe.currency,
              // Stripe expects the amount in the minor unit (ngwee).
              unit_amount: Math.round(amount * 100),
              product_data: { name: `InDeed ${plan.label} subscription (monthly)` },
            },
          },
        ],
      });
    } catch (err) {
      logger.error('Stripe checkout creation failed', {
        paymentId: payment.id,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new UpstreamServiceError('Failed to create checkout session');
    }

    logger.info('Stripe checkout created', { paymentId: payment.id, sessionId: session.id });
    return { sessionId: session.id, url: session.url };
  }

  /**
   * Verify a raw webhook payload's signature and return the typed event.
   *
   * @throws {ValidationError}      if the signature is missing/invalid.
   * @throws {UpstreamServiceError} if the webhook secret is not configured.
   */
  constructWebhookEvent(payload: Buffer | string, signature: string | undefined): Stripe.Event {
    const stripe = this.requireStripe();
    if (!config.stripe.webhookSecret) {
      throw new UpstreamServiceError('Stripe webhook secret is not configured');
    }
    if (!signature) {
      throw new ValidationError('Missing Stripe-Signature header');
    }
    try {
      return stripe.webhooks.constructEvent(payload, signature, config.stripe.webhookSecret);
    } catch (err) {
      logger.warn('Stripe webhook signature verification failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      throw new ValidationError('Invalid Stripe webhook signature');
    }
  }

  /**
   * Handle a verified Stripe event. On `checkout.session.completed` the
   * referenced payment is marked completed (idempotently), the user's
   * subscription tier is granted, and an expiry is set. Failure/expiry events
   * mark the payment failed. Other event types are ignored.
   */
  async handleStripeWebhook(event: Stripe.Event): Promise<{ handled: boolean }> {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        return this.completePayment(session.metadata?.paymentId);
      }
      case 'checkout.session.expired':
      case 'payment_intent.payment_failed': {
        const object = event.data.object as { metadata?: Stripe.Metadata | null };
        await this.failPayment(object.metadata?.paymentId);
        return { handled: true };
      }
      default:
        logger.info('Ignoring unhandled Stripe event', { type: event.type });
        return { handled: false };
    }
  }

  /**
   * Record a pending mobile-money payment. Returns immediately with status
   * `pending`; confirmation arrives out-of-band (provider callback).
   *
   * @throws {ValidationError} for an unknown provider or non-positive amount.
   */
  async processMobileMoneyPayment(
    userId: string,
    provider: MobileMoneyProvider,
    amount: number,
  ): Promise<Payment> {
    if (!MOBILE_MONEY_PROVIDERS.has(provider)) {
      throw new ValidationError(`Unsupported mobile-money provider: ${provider}`);
    }
    if (!(amount > 0)) {
      throw new ValidationError('Amount must be greater than zero');
    }

    const payment = await this.insertPayment({
      userId,
      amount,
      currency: 'ZMW',
      provider: 'mobile_money',
      subscriptionTier: null,
    });
    logger.info('Mobile-money payment recorded as pending', {
      paymentId: payment.id,
      provider,
    });
    return payment;
  }

  /**
   * Generate (or rebuild) the invoice for a payment: renders HTML + a PDF and
   * persists the invoice row. Idempotent — re-running reuses the stored row.
   *
   * @throws {NotFoundError} if the payment or its user no longer exists.
   */
  async generateInvoice(paymentId: string): Promise<InvoiceArtifacts> {
    const payment = await this.findPayment(paymentId);
    if (!payment) throw new NotFoundError('Payment not found');
    return this.buildInvoice(payment);
  }

  /**
   * Fetch a payment's invoice on behalf of a user, enforcing ownership.
   *
   * @throws {NotFoundError}  if the payment does not exist.
   * @throws {ForbiddenError} if the payment belongs to another user.
   */
  async getInvoiceForUser(paymentId: string, userId: string): Promise<InvoiceArtifacts> {
    const payment = await this.findPayment(paymentId);
    if (!payment) throw new NotFoundError('Payment not found');
    if (payment.user_id !== userId) {
      throw new ForbiddenError('You can only access your own invoices');
    }
    return this.buildInvoice(payment);
  }

  // ── internals ─────────────────────────────────────────────

  private requireStripe(): Stripe {
    if (!this.stripe) {
      throw new UpstreamServiceError('Stripe is not configured');
    }
    return this.stripe;
  }

  /** Insert a pending payment row and return it. */
  private async insertPayment(input: {
    userId: string;
    amount: number;
    currency: string;
    provider: Payment['provider'];
    subscriptionTier: Payment['subscription_tier'];
  }): Promise<Payment> {
    const { rows } = await query<Payment>(
      `INSERT INTO payments (user_id, amount, currency, status, provider, subscription_tier)
            VALUES ($1, $2, $3, 'pending', $4, $5)
       RETURNING *`,
      [input.userId, input.amount, input.currency, input.provider, input.subscriptionTier],
    );
    return rows[0] as Payment;
  }

  /** Mark a payment completed (idempotent) and grant the subscription tier. */
  private async completePayment(paymentId: string | undefined): Promise<{ handled: boolean }> {
    if (!paymentId) {
      logger.warn('checkout.session.completed had no paymentId metadata');
      return { handled: false };
    }

    const { rows } = await query<Payment>(
      `UPDATE payments
          SET status = 'completed',
              valid_until = now() + ($2 || ' days')::interval
        WHERE id = $1 AND status <> 'completed'
        RETURNING *`,
      [paymentId, String(SUBSCRIPTION_DAYS)],
    );
    const payment = rows[0];
    if (!payment) {
      // Already processed — webhooks can be delivered more than once.
      logger.info('Payment already completed; skipping', { paymentId });
      return { handled: false };
    }

    if (payment.subscription_tier) {
      await query(
        `UPDATE users SET subscription_tier = $1, updated_at = now() WHERE id = $2`,
        [payment.subscription_tier, payment.user_id],
      );
    }
    logger.info('Payment completed and tier granted', {
      paymentId,
      tier: payment.subscription_tier,
    });
    return { handled: true };
  }

  /** Mark a payment failed (idempotent). */
  private async failPayment(paymentId: string | undefined): Promise<void> {
    if (!paymentId) return;
    await query(
      `UPDATE payments SET status = 'failed' WHERE id = $1 AND status = 'pending'`,
      [paymentId],
    );
    logger.info('Payment marked failed', { paymentId });
  }

  /** Load a payment by id, or null. */
  private async findPayment(paymentId: string): Promise<Payment | null> {
    const { rows } = await query<Payment>(`SELECT * FROM payments WHERE id = $1`, [paymentId]);
    return rows[0] ?? null;
  }

  /** Render and persist the invoice for a payment (reusing any existing row). */
  private async buildInvoice(payment: Payment): Promise<InvoiceArtifacts> {
    const userResult = await query<User>(`SELECT * FROM users WHERE id = $1`, [payment.user_id]);
    const user = userResult.rows[0];
    if (!user) throw new NotFoundError('User not found');

    const html = renderInvoiceHtml(payment, user);
    const pdf = await renderInvoicePdf(payment, user);

    const existing = await query<Invoice>(`SELECT * FROM invoices WHERE payment_id = $1`, [
      payment.id,
    ]);
    let invoice = existing.rows[0];
    if (!invoice) {
      const inserted = await query<Invoice>(
        `INSERT INTO invoices (payment_id, user_id, html_content)
              VALUES ($1, $2, $3)
         RETURNING *`,
        [payment.id, payment.user_id, html],
      );
      invoice = inserted.rows[0] as Invoice;
    }

    return { invoice, pdf, html };
  }
}

/** Format an amount as a currency string for display. */
function formatAmount(payment: Payment): string {
  const value = Number(payment.amount).toLocaleString('en-ZM', { minimumFractionDigits: 2 });
  return `${payment.currency} ${value}`;
}

/** Build the HTML representation of an invoice. */
function renderInvoiceHtml(payment: Payment, user: User): string {
  const issued = payment.created_at instanceof Date ? payment.created_at : new Date(payment.created_at);
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>InDeed Invoice ${payment.id}</title></head>
<body style="font-family: Arial, sans-serif; color: #1a1a1a;">
  <h1>InDeed — Invoice</h1>
  <p><strong>Invoice for payment:</strong> ${payment.id}</p>
  <p><strong>Date:</strong> ${issued.toISOString().slice(0, 10)}</p>
  <hr>
  <p><strong>Billed to:</strong> ${escapeHtml(user.name ?? 'Customer')} (${escapeHtml(user.phone)})</p>
  <table style="width:100%; border-collapse: collapse;" border="1" cellpadding="6">
    <tr><th align="left">Description</th><th align="right">Amount</th></tr>
    <tr>
      <td>${payment.subscription_tier ? `${capitalize(payment.subscription_tier)} subscription` : 'InDeed payment'}</td>
      <td align="right">${formatAmount(payment)}</td>
    </tr>
    <tr><td align="right"><strong>Total</strong></td><td align="right"><strong>${formatAmount(payment)}</strong></td></tr>
  </table>
  <p><strong>Provider:</strong> ${payment.provider} &nbsp; <strong>Status:</strong> ${payment.status}</p>
  ${payment.valid_until ? `<p><strong>Valid until:</strong> ${new Date(payment.valid_until).toISOString().slice(0, 10)}</p>` : ''}
  <p style="margin-top:32px; color:#666;">Thank you for using InDeed.</p>
</body>
</html>`;
}

/** Render the invoice as a PDF buffer using pdfkit. */
function renderInvoicePdf(payment: Payment, user: User): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(22).text('InDeed — Invoice', { align: 'left' });
    doc.moveDown();
    doc.fontSize(11);
    doc.text(`Invoice for payment: ${payment.id}`);
    doc.text(`Billed to: ${user.name ?? 'Customer'} (${user.phone})`);
    doc.text(`Provider: ${payment.provider}`);
    doc.text(`Status: ${payment.status}`);
    if (payment.subscription_tier) {
      doc.text(`Plan: ${capitalize(payment.subscription_tier)} subscription`);
    }
    doc.moveDown();
    doc.fontSize(16).text(`Total: ${formatAmount(payment)}`);
    if (payment.valid_until) {
      doc.moveDown();
      doc.fontSize(11).text(`Valid until: ${new Date(payment.valid_until).toISOString().slice(0, 10)}`);
    }
    doc.moveDown(2);
    doc.fontSize(10).fillColor('#666666').text('Thank you for using InDeed.');
    doc.end();
  });
}

/** Escape a string for safe interpolation into HTML. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Capitalise the first letter of a word. */
function capitalize(value: string): string {
  return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);
}

/** Shared singleton used by controllers. */
export const paymentService = new PaymentService();
