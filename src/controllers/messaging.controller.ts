import type { Response } from 'express';
import { messagingService, MessagingService } from '../services/messaging.service';
import { propertyService, PropertyService } from '../services/property.service';
import { NotFoundError, UnauthorizedError, ValidationError } from '../utils/errors';
import type { AuthenticatedRequest } from '../middleware/auth';
import type { ValidatedLocals } from '../middleware/validate';
import type { MessageSellerBody, SendMessageBody } from '../utils/validators';

/**
 * HTTP handlers for buyer ↔ seller messaging. Collaborators are constructor-
 * injected for testability; a default-wired singleton is exported for the routes.
 */
export class MessagingController {
  constructor(
    private readonly messaging: MessagingService = messagingService,
    private readonly properties: PropertyService = propertyService,
  ) {}

  /** POST /messages — send a message into an existing conversation. */
  send = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const auth = this.requireAuth(req);
    const { conversation_id, content } = (res.locals as ValidatedLocals).body as SendMessageBody;

    const message = await this.messaging.sendMessage(conversation_id, auth.sub, content);
    res.status(201).json(message);
  };

  /** GET /conversations — list the authenticated user's conversations. */
  listConversations = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const auth = this.requireAuth(req);
    const conversations = await this.messaging.getConversations(auth.sub);
    res.status(200).json(conversations);
  };

  /** GET /conversations/:id/messages — fetch a thread and mark it read. */
  listMessages = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const auth = this.requireAuth(req);
    const conversationId = req.params.id;
    if (!conversationId) throw new ValidationError('Missing conversation id');

    const messages = await this.messaging.getMessages(conversationId, auth.sub);
    res.status(200).json(messages);
  };

  /**
   * POST /properties/:id/message-seller — start (or reuse) a conversation with a
   * listing's seller and send the first message. The buyer is the caller.
   */
  messageSeller = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const auth = this.requireAuth(req);
    const propertyId = req.params.id;
    if (!propertyId) throw new ValidationError('Missing property id');

    const { content } = (res.locals as ValidatedLocals).body as MessageSellerBody;

    const property = await this.properties.findById(propertyId);
    if (!property) throw new NotFoundError('Property not found');
    if (property.seller_id === auth.sub) {
      throw new ValidationError('You cannot message yourself about your own listing');
    }

    const conversation = await this.messaging.getOrCreateConversation(
      propertyId,
      auth.sub,
      property.seller_id,
    );
    const message = await this.messaging.sendMessage(conversation.id, auth.sub, content);

    res.status(201).json({ conversation, message });
  };

  private requireAuth(req: AuthenticatedRequest): NonNullable<AuthenticatedRequest['auth']> {
    if (!req.auth) throw new UnauthorizedError();
    return req.auth;
  }
}

export const messagingController = new MessagingController();
