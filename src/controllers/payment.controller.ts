import type { Request, Response } from 'express';
import { paymentService, PaymentService, PLANS } from '../services/payment.service';
import { UnauthorizedError, ValidationError } from '../utils/errors';
import type { AuthenticatedRequest } from '../middleware/auth';
import type { ValidatedLocals } from '../middleware/validate';
import type { MobileMoneyBody, StripeCheckoutBody } from '../utils/validators';

/**
 * HTTP handlers for payments. The service is constructor-injected for
 * testability; a default-wired singleton is exported for the routes.
 */
export class PaymentController {
  constructor(private readonly payments: PaymentService = paymentService) {}

  /** POST /payments/stripe/checkout — create a Checkout Session for a plan. */
  stripeCheckout = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const auth = this.requireAuth(req);
    const { tier } = (res.locals as ValidatedLocals).body as StripeCheckoutBody;

    // Price is taken from the server-side plan catalogue, never the client.
    const plan = PLANS[tier];
    const result = await this.payments.createStripeCheckout(auth.sub, tier, plan.amount);
    res.status(201).json(result);
  };

  /**
   * POST /payments/webhook/stripe — Stripe event sink (no auth; verified by
   * signature). `req.body` is the raw Buffer (see the raw-body middleware).
   */
  stripeWebhook = async (req: Request, res: Response): Promise<void> => {
    const signature = req.headers['stripe-signature'];
    const event = this.payments.constructWebhookEvent(
      req.body as Buffer,
      typeof signature === 'string' ? signature : undefined,
    );
    const result = await this.payments.handleStripeWebhook(event);
    res.status(200).json({ received: true, handled: result.handled });
  };

  /** POST /payments/mobile-money — record a pending mobile-money payment. */
  mobileMoney = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const auth = this.requireAuth(req);
    const { provider, amount } = (res.locals as ValidatedLocals).body as MobileMoneyBody;

    const payment = await this.payments.processMobileMoneyPayment(auth.sub, provider, amount);
    res.status(201).json(payment);
  };

  /**
   * GET /payments/invoice/:id — return the invoice for a payment (owner only).
   * `?format=pdf` streams the PDF; otherwise JSON with the HTML content.
   */
  invoice = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const auth = this.requireAuth(req);
    const paymentId = req.params.id;
    if (!paymentId) throw new ValidationError('Missing payment id');

    const { invoice, pdf, html } = await this.payments.getInvoiceForUser(paymentId, auth.sub);

    if (req.query.format === 'pdf') {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="invoice-${invoice.id}.pdf"`);
      res.status(200).send(pdf);
      return;
    }

    res.status(200).json({
      id: invoice.id,
      payment_id: invoice.payment_id,
      user_id: invoice.user_id,
      pdf_url: invoice.pdf_url,
      html_content: html,
      created_at: invoice.created_at,
    });
  };

  private requireAuth(req: AuthenticatedRequest): NonNullable<AuthenticatedRequest['auth']> {
    if (!req.auth) throw new UnauthorizedError();
    return req.auth;
  }
}

export const paymentController = new PaymentController();
