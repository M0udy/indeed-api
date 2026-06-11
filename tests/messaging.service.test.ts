// Mock the database layer so the service runs against controlled query results.
jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  withTransaction: jest.fn(),
  isDatabaseConnected: jest.fn(),
  closePool: jest.fn(),
  pool: {},
}));

import { MessagingService } from '../src/services/messaging.service';
import { query } from '../src/config/database';
import { ForbiddenError, NotFoundError, ValidationError } from '../src/utils/errors';
import type { Conversation, Message } from '../src/types';

const mockQuery = query as jest.Mock;

/** Queue the next query() resolution with the given rows. */
function nextRows(rows: unknown[]): void {
  mockQuery.mockResolvedValueOnce({ rows, rowCount: rows.length });
}

/** The SQL text of the Nth query() call (0-indexed). */
function sqlOf(callIndex: number): string {
  return String(mockQuery.mock.calls[callIndex]?.[0] ?? '');
}

function fakeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv-1',
    property_id: 'prop-1',
    buyer_id: 'buyer-1',
    seller_id: 'seller-1',
    created_at: new Date('2026-01-01T00:00:00Z'),
    last_message_at: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function fakeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    conversation_id: 'conv-1',
    sender_id: 'buyer-1',
    content: 'Hello, is this plot still available?',
    read_at: null,
    created_at: new Date('2026-01-02T00:00:00Z'),
    ...overrides,
  };
}

describe('MessagingService', () => {
  const service = new MessagingService();

  beforeEach(() => {
    mockQuery.mockReset();
  });

  describe('getOrCreateConversation', () => {
    it('upserts and returns the conversation', async () => {
      const convo = fakeConversation();
      nextRows([convo]);

      const result = await service.getOrCreateConversation('prop-1', 'buyer-1', 'seller-1');

      expect(result).toEqual(convo);
      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(sqlOf(0)).toContain('ON CONFLICT');
      expect(mockQuery.mock.calls[0]?.[1]).toEqual(['prop-1', 'buyer-1', 'seller-1']);
    });

    it('rejects a conversation where buyer and seller are the same', async () => {
      await expect(
        service.getOrCreateConversation('prop-1', 'same-user', 'same-user'),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  describe('sendMessage', () => {
    it('inserts the message and bumps last_message_at', async () => {
      nextRows([fakeConversation()]); // participant check
      const message = fakeMessage();
      nextRows([message]); // insert
      nextRows([]); // update last_message_at

      const result = await service.sendMessage('conv-1', 'buyer-1', 'Hello there');

      expect(result).toEqual(message);
      expect(mockQuery).toHaveBeenCalledTimes(3);
      expect(sqlOf(1)).toContain('INSERT INTO messages');
      expect(sqlOf(2)).toContain('UPDATE conversations');
    });

    it('trims content before storing it', async () => {
      nextRows([fakeConversation()]);
      nextRows([fakeMessage()]);
      nextRows([]);

      await service.sendMessage('conv-1', 'buyer-1', '   padded message   ');

      expect(mockQuery.mock.calls[1]?.[1]).toEqual(['conv-1', 'buyer-1', 'padded message']);
    });

    it('rejects empty content before touching the database', async () => {
      await expect(service.sendMessage('conv-1', 'buyer-1', '   ')).rejects.toBeInstanceOf(
        ValidationError,
      );
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('rejects content over the length limit', async () => {
      const huge = 'x'.repeat(5001);
      await expect(service.sendMessage('conv-1', 'buyer-1', huge)).rejects.toBeInstanceOf(
        ValidationError,
      );
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('throws NotFound when the conversation does not exist', async () => {
      nextRows([]); // participant check finds nothing
      await expect(service.sendMessage('missing', 'buyer-1', 'hi')).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });

    it('forbids a non-participant from sending', async () => {
      nextRows([fakeConversation({ buyer_id: 'buyer-1', seller_id: 'seller-1' })]);
      await expect(service.sendMessage('conv-1', 'intruder', 'hi')).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      expect(mockQuery).toHaveBeenCalledTimes(1); // only the participant check ran
    });

    it('allows the seller (other participant) to send', async () => {
      nextRows([fakeConversation()]);
      nextRows([fakeMessage({ sender_id: 'seller-1' })]);
      nextRows([]);

      const result = await service.sendMessage('conv-1', 'seller-1', 'Yes, still available');
      expect(result.sender_id).toBe('seller-1');
    });
  });

  describe('getMessages', () => {
    it('marks the other party messages read, then returns the thread', async () => {
      nextRows([fakeConversation()]); // participant check
      nextRows([]); // mark-read UPDATE
      const messages = [fakeMessage(), fakeMessage({ id: 'msg-2' })];
      nextRows(messages); // select

      const result = await service.getMessages('conv-1', 'seller-1');

      expect(result).toEqual(messages);
      expect(mockQuery).toHaveBeenCalledTimes(3);
      expect(sqlOf(1)).toContain('read_at');
      expect(sqlOf(1)).toContain('UPDATE messages');
      // The mark-read query targets the conversation and excludes the reader's own messages.
      expect(mockQuery.mock.calls[1]?.[1]).toEqual(['conv-1', 'seller-1']);
      expect(sqlOf(2)).toContain('ORDER BY created_at ASC');
    });

    it('throws NotFound for a missing conversation', async () => {
      nextRows([]);
      await expect(service.getMessages('missing', 'buyer-1')).rejects.toBeInstanceOf(NotFoundError);
    });

    it('forbids a non-participant from reading', async () => {
      nextRows([fakeConversation()]);
      await expect(service.getMessages('conv-1', 'intruder')).rejects.toBeInstanceOf(ForbiddenError);
      expect(mockQuery).toHaveBeenCalledTimes(1); // no mark-read / select ran
    });
  });

  describe('getConversations', () => {
    it('returns the user conversations with unread + preview fields', async () => {
      const summary = { ...fakeConversation(), unread_count: 2, last_message: 'See you then' };
      nextRows([summary]);

      const result = await service.getConversations('buyer-1');

      expect(result).toEqual([summary]);
      expect(sqlOf(0)).toContain('unread_count');
      expect(mockQuery.mock.calls[0]?.[1]).toEqual(['buyer-1']);
    });

    it('returns an empty array when the user has no conversations', async () => {
      nextRows([]);
      const result = await service.getConversations('lonely-user');
      expect(result).toEqual([]);
    });
  });
});
