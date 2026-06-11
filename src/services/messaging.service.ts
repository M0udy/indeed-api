import { query } from '../config/database';
import { logger } from '../utils/logger';
import { ForbiddenError, NotFoundError, ValidationError } from '../utils/errors';
import type { Conversation, ConversationSummary, Message } from '../types';

/** Maximum message length, mirrored by the request validator. */
const MAX_CONTENT_LENGTH = 5000;

/**
 * Buyer ↔ seller messaging for property listings.
 *
 * Conversations are unique per `(property, buyer, seller)` triple. Every read
 * path enforces that the requesting user is a participant of the conversation,
 * so one user can never see another's threads. All SQL is parameterised.
 */
export class MessagingService {
  /**
   * Find the conversation for a property/buyer/seller triple, creating it if it
   * does not exist. Implemented as a single atomic upsert against the
   * `uq_conversation` unique constraint.
   *
   * @throws {ValidationError} if buyer and seller are the same user.
   */
  async getOrCreateConversation(
    propertyId: string,
    buyerId: string,
    sellerId: string,
  ): Promise<Conversation> {
    if (buyerId === sellerId) {
      throw new ValidationError('Buyer and seller cannot be the same user');
    }

    const { rows } = await query<Conversation>(
      `INSERT INTO conversations (property_id, buyer_id, seller_id)
            VALUES ($1, $2, $3)
       ON CONFLICT (property_id, buyer_id, seller_id)
       DO UPDATE SET last_message_at = conversations.last_message_at
       RETURNING *`,
      [propertyId, buyerId, sellerId],
    );
    // The upsert always returns exactly one row.
    return rows[0] as Conversation;
  }

  /**
   * Send a message into a conversation. The sender must be a participant.
   * Inserts the message and bumps the conversation's `last_message_at`.
   *
   * @throws {ValidationError} for empty / oversized content.
   * @throws {NotFoundError}   if the conversation does not exist.
   * @throws {ForbiddenError}  if the sender is not a participant.
   */
  async sendMessage(conversationId: string, senderId: string, content: string): Promise<Message> {
    const trimmed = content.trim();
    if (trimmed.length === 0) {
      throw new ValidationError('Message cannot be empty');
    }
    if (trimmed.length > MAX_CONTENT_LENGTH) {
      throw new ValidationError(`Message exceeds the ${MAX_CONTENT_LENGTH}-character limit`);
    }

    await this.assertParticipant(conversationId, senderId);

    const inserted = await query<Message>(
      `INSERT INTO messages (conversation_id, sender_id, content)
            VALUES ($1, $2, $3)
       RETURNING *`,
      [conversationId, senderId, trimmed],
    );
    const message = inserted.rows[0] as Message;

    await query(
      `UPDATE conversations SET last_message_at = now() WHERE id = $1`,
      [conversationId],
    );

    logger.info('Message sent', { conversationId, messageId: message.id });
    return message;
  }

  /**
   * List the requesting user's conversations (as buyer or seller), newest
   * activity first, each annotated with the user's unread count and a preview of
   * the latest message.
   */
  async getConversations(userId: string): Promise<ConversationSummary[]> {
    const { rows } = await query<ConversationSummary>(
      `SELECT c.*,
              COALESCE(unread.cnt, 0)::int AS unread_count,
              latest.content              AS last_message
         FROM conversations c
         LEFT JOIN LATERAL (
           SELECT count(*) AS cnt
             FROM messages m
            WHERE m.conversation_id = c.id
              AND m.sender_id <> $1
              AND m.read_at IS NULL
         ) unread ON true
         LEFT JOIN LATERAL (
           SELECT content
             FROM messages m
            WHERE m.conversation_id = c.id
            ORDER BY m.created_at DESC
            LIMIT 1
         ) latest ON true
        WHERE c.buyer_id = $1 OR c.seller_id = $1
        ORDER BY c.last_message_at DESC`,
      [userId],
    );
    return rows;
  }

  /**
   * Fetch all messages in a conversation, oldest first, after marking the
   * other participant's unread messages as read. The requesting user must be a
   * participant.
   *
   * @throws {NotFoundError}  if the conversation does not exist.
   * @throws {ForbiddenError} if the user is not a participant.
   */
  async getMessages(conversationId: string, userId: string): Promise<Message[]> {
    await this.assertParticipant(conversationId, userId);

    // Mark messages from the other party as read.
    await query(
      `UPDATE messages
          SET read_at = now()
        WHERE conversation_id = $1
          AND sender_id <> $2
          AND read_at IS NULL`,
      [conversationId, userId],
    );

    const { rows } = await query<Message>(
      `SELECT * FROM messages
        WHERE conversation_id = $1
        ORDER BY created_at ASC`,
      [conversationId],
    );
    return rows;
  }

  /**
   * Load a conversation and verify `userId` is its buyer or seller.
   *
   * @throws {NotFoundError}  if the conversation does not exist.
   * @throws {ForbiddenError} if the user is not a participant.
   */
  private async assertParticipant(conversationId: string, userId: string): Promise<Conversation> {
    const { rows } = await query<Conversation>(
      `SELECT * FROM conversations WHERE id = $1`,
      [conversationId],
    );
    const conversation = rows[0];
    if (!conversation) {
      throw new NotFoundError('Conversation not found');
    }
    if (conversation.buyer_id !== userId && conversation.seller_id !== userId) {
      throw new ForbiddenError('You are not a participant in this conversation');
    }
    return conversation;
  }
}

/** Shared singleton used by controllers. */
export const messagingService = new MessagingService();
