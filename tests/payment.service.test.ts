// Mock the database layer so the service runs against controlled query results.
jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  withTransaction: jest.fn(),
  isDatabaseConnected: jest.fn(),
  closePool: jest.fn(),
  pool: {},
}));

import Stripe from 'stripe';
import { PaymentService, PLANS } from '../src/services/payment.service';
import { query } from '../src/config/database';
import { ForbiddenError, NotFoundError, ValidationError } from '../src/utils/errors';
import type { Payment, User } from '../src/types';

const mockQuery = query as jest.Mock;

/** Queue the next query() resolution with the given rows. */
function nextRows(rows: unknown[]): void {
  mockQuery.mockResolvedValueOnce({ rows, rowCount: rows.length });
}

function fakePayment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: 'pay-1',
    user_id: 'user-1',
    amount: '600.00',
    currency: 'ZMW',
    status: 'pending',
    provider: 'stripe',
    subscription_tier: 'premium',
    valid_until: null,
    created_at: new Date('2026-06-11T00:00:00Z'),
    ...overrides,
  };
}

function fakeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    phone: '+260123456789',
    email: null,
    name: 'Jane Buyer',
    kyc_status: 'pending',
    subscription_tier: 'free',
    verification_badge: false,
    admin_role: 'user',
    suspended_at: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

/** Build a fake Stripe client exposing only the surface the service uses. */
function fakeStripe(overrides?: {
  createSession?: jest.Mock;
  constructEvent?: jest.Mock;
}): Stripe {
  const createSession =
    overrides?.createSession ??
    jest.fn().mockResolvedValue({ id: 'cs_test_123', url: 'https://checkout.stripe.com/c/pay/cs_test_123' });
  const constructEvent = overrides?.constructEvent ?? jest.fn();
  return {
    checkout: { sessions: { create: createSession } },
    webhooks: { constructEvent },
  } as unknown as Stripe;
}

describe('PaymentService', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  describe('plan catalogue', () => {
    it('prices the three plans in Kwacha and maps them to subscription tiers', () => {
      expect(PLANS.buyer).toMatchObject({ amount: 600, grants: 'premium' });
      expect(PLANS.seller).toMatchObject({ amount: 1_200, grants: 'professional' });
      expect(PLANS.bank).toMatchObject({ amount: 8_000, grants: 'enterprise', perCheckAmount: 400 });
    });
  });

  describe('createStripeCheckout', () => {
    it('records a pending payment and creates a session with the minor-unit amount', async () => {
      const createSession = jest
        .fn()
        .mockResolvedValue({ id: 'cs_test_123', url: 'https://stripe.test/cs_test_123' });
      const service = new PaymentService(fakeStripe({ createSession }));
      nextRows([fakePayment()]); // insert payment

      const result = await service.createStripeCheckout('user-1', 'buyer', PLANS.buyer.amount);

      expect(result).toEqual({ sessionId: 'cs_test_123', url: 'https://stripe.test/cs_test_123' });
      const params = createSession.mock.calls[0][0];
      expect(params.line_items[0].price_data.unit_amount).toBe(60_000); // 600 Kwacha → 60,000 ngwee
      expect(params.metadata).toMatchObject({ paymentId: 'pay-1', subscriptionTier: 'premium' });
    });

    it('rejects an amount of zero before charging', async () => {
      const service = new PaymentService(fakeStripe());
      await expect(service.createStripeCheckout('user-1', 'buyer', 0)).rejects.toBeInstanceOf(
        ValidationError,
      );
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('fails clearly when Stripe is not configured', async () => {
      const service = new PaymentService(); // no client, no key in test env
      await expect(
        service.createStripeCheckout('user-1', 'buyer', 600),
      ).rejects.toThrow(/not configured/i);
    });
  });

  describe('handleStripeWebhook', () => {
    it('completes the payment and grants the subscription tier', async () => {
      const service = new PaymentService(fakeStripe());
      nextRows([fakePayment({ status: 'completed', subscription_tier: 'premium' })]); // update payment
      nextRows([]); // update user tier

      const event = {
        type: 'checkout.session.completed',
        data: { object: { metadata: { paymentId: 'pay-1' } } },
      } as unknown as Stripe.Event;

      const result = await service.handleStripeWebhook(event);

      expect(result.handled).toBe(true);
      expect(mockQuery).toHaveBeenCalledTimes(2);
      expect(String(mockQuery.mock.calls[0][0])).toContain('UPDATE payments');
      expect(String(mockQuery.mock.calls[1][0])).toContain('UPDATE users');
      expect(mockQuery.mock.calls[1][1]).toEqual(['premium', 'user-1']);
    });

    it('is idempotent — a re-delivered completion does not re-grant', async () => {
      const service = new PaymentService(fakeStripe());
      nextRows([]); // update payment matched nothing (already completed)

      const event = {
        type: 'checkout.session.completed',
        data: { object: { metadata: { paymentId: 'pay-1' } } },
      } as unknown as Stripe.Event;

      const result = await service.handleStripeWebhook(event);

      expect(result.handled).toBe(false);
      expect(mockQuery).toHaveBeenCalledTimes(1); // no user update
    });

    it('marks the payment failed on a failed payment intent', async () => {
      const service = new PaymentService(fakeStripe());
      nextRows([]); // update payments set failed

      const event = {
        type: 'payment_intent.payment_failed',
        data: { object: { metadata: { paymentId: 'pay-1' } } },
      } as unknown as Stripe.Event;

      const result = await service.handleStripeWebhook(event);

      expect(result.handled).toBe(true);
      expect(String(mockQuery.mock.calls[0][0])).toContain("status = 'failed'");
    });

    it('ignores unrelated event types without touching the database', async () => {
      const service = new PaymentService(fakeStripe());
      const event = { type: 'customer.created', data: { object: {} } } as unknown as Stripe.Event;

      const result = await service.handleStripeWebhook(event);

      expect(result.handled).toBe(false);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('handles a completion event with no paymentId metadata', async () => {
      const service = new PaymentService(fakeStripe());
      const event = {
        type: 'checkout.session.completed',
        data: { object: { metadata: {} } },
      } as unknown as Stripe.Event;

      const result = await service.handleStripeWebhook(event);
      expect(result.handled).toBe(false);
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  describe('constructWebhookEvent', () => {
    it('returns the event when the signature verifies', () => {
      const event = { type: 'checkout.session.completed' } as Stripe.Event;
      const constructEvent = jest.fn().mockReturnValue(event);
      const service = new PaymentService(fakeStripe({ constructEvent }));
      // Webhook secret is set via test env default ("test-...") so verification is attempted.
      const result = service.constructWebhookEvent(Buffer.from('{}'), 'sig_test');
      expect(result).toBe(event);
    });

    it('throws a ValidationError when the signature is missing', () => {
      const service = new PaymentService(fakeStripe());
      expect(() => service.constructWebhookEvent(Buffer.from('{}'), undefined)).toThrow(
        ValidationError,
      );
    });

    it('throws a ValidationError when verification fails', () => {
      const constructEvent = jest.fn().mockImplementation(() => {
        throw new Error('bad signature');
      });
      const service = new PaymentService(fakeStripe({ constructEvent }));
      expect(() => service.constructWebhookEvent(Buffer.from('{}'), 'sig_bad')).toThrow(
        ValidationError,
      );
    });
  });

  describe('processMobileMoneyPayment', () => {
    it('records a pending mobile-money payment', async () => {
      const service = new PaymentService(fakeStripe());
      nextRows([fakePayment({ provider: 'mobile_money', subscription_tier: null })]);

      const payment = await service.processMobileMoneyPayment('user-1', 'mtn', 600);

      expect(payment.status).toBe('pending');
      expect(payment.provider).toBe('mobile_money');
      expect(String(mockQuery.mock.calls[0][0])).toContain('INSERT INTO payments');
    });

    it('rejects an unsupported provider', async () => {
      const service = new PaymentService(fakeStripe());
      await expect(
        // @ts-expect-error — intentionally invalid provider
        service.processMobileMoneyPayment('user-1', 'paypal', 600),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('rejects a non-positive amount', async () => {
      const service = new PaymentService(fakeStripe());
      await expect(service.processMobileMoneyPayment('user-1', 'airtel', 0)).rejects.toBeInstanceOf(
        ValidationError,
      );
    });
  });

  describe('generateInvoice', () => {
    it('renders HTML + a PDF and persists a new invoice', async () => {
      const service = new PaymentService(fakeStripe());
      nextRows([fakePayment({ status: 'completed', subscription_tier: 'premium' })]); // find payment
      nextRows([fakeUser()]); // find user
      nextRows([]); // no existing invoice
      nextRows([{ id: 'inv-1', payment_id: 'pay-1', user_id: 'user-1', pdf_url: null, html_content: '<html></html>', created_at: new Date() }]); // insert

      const { invoice, pdf, html } = await service.generateInvoice('pay-1');

      expect(invoice.id).toBe('inv-1');
      expect(Buffer.isBuffer(pdf)).toBe(true);
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-'); // valid PDF header
      expect(html).toContain('ZMW');
      expect(html).toContain('Jane Buyer');
      expect(String(mockQuery.mock.calls[3][0])).toContain('INSERT INTO invoices');
    });

    it('reuses an existing invoice instead of inserting a duplicate', async () => {
      const service = new PaymentService(fakeStripe());
      const existing = { id: 'inv-existing', payment_id: 'pay-1', user_id: 'user-1', pdf_url: null, html_content: '<html></html>', created_at: new Date() };
      nextRows([fakePayment()]); // find payment
      nextRows([fakeUser()]); // find user
      nextRows([existing]); // existing invoice found

      const { invoice } = await service.generateInvoice('pay-1');

      expect(invoice.id).toBe('inv-existing');
      expect(mockQuery).toHaveBeenCalledTimes(3); // no insert
    });

    it('throws NotFound when the payment does not exist', async () => {
      const service = new PaymentService(fakeStripe());
      nextRows([]); // payment not found
      await expect(service.generateInvoice('missing')).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('getInvoiceForUser', () => {
    it('returns the invoice for the owner', async () => {
      const service = new PaymentService(fakeStripe());
      nextRows([fakePayment({ user_id: 'user-1' })]); // find payment (ownership)
      nextRows([fakeUser()]); // find user
      nextRows([]); // no existing invoice
      nextRows([{ id: 'inv-1', payment_id: 'pay-1', user_id: 'user-1', pdf_url: null, html_content: '<html></html>', created_at: new Date() }]);

      const { invoice } = await service.getInvoiceForUser('pay-1', 'user-1');
      expect(invoice.id).toBe('inv-1');
    });

    it('forbids access to another user’s invoice', async () => {
      const service = new PaymentService(fakeStripe());
      nextRows([fakePayment({ user_id: 'someone-else' })]);
      await expect(service.getInvoiceForUser('pay-1', 'user-1')).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      expect(mockQuery).toHaveBeenCalledTimes(1); // stopped at ownership check
    });
  });
});
