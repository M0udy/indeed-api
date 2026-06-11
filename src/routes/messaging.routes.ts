import { Router } from 'express';
import { messagingController } from '../controllers/messaging.controller';
import { authenticate } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';
import { messageSellerSchema, sendMessageSchema } from '../utils/validators';

/**
 * Messaging router — buyer ↔ seller conversations and messages.
 *
 * Mounted at the application root so it owns `/messages` and `/conversations`,
 * plus the `/properties/:id/message-seller` shortcut. All routes require auth.
 */
export const messagingRouter = Router();

messagingRouter.post(
  '/messages',
  authenticate,
  validateBody(sendMessageSchema),
  asyncHandler(messagingController.send),
);

messagingRouter.get('/conversations', authenticate, asyncHandler(messagingController.listConversations));

messagingRouter.get(
  '/conversations/:id/messages',
  authenticate,
  asyncHandler(messagingController.listMessages),
);

messagingRouter.post(
  '/properties/:id/message-seller',
  authenticate,
  validateBody(messageSellerSchema),
  asyncHandler(messagingController.messageSeller),
);
