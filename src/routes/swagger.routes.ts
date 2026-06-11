import { Router, type Request, type Response } from 'express';
import swaggerUi from 'swagger-ui-express';
import { openApiSpec } from '../utils/swagger';

/**
 * API documentation routes.
 *   - GET /api-docs      → interactive Swagger UI
 *   - GET /api-docs.json → raw OpenAPI 3.0 document
 */
export const swaggerRouter = Router();

// Raw spec (registered before the UI mount so it isn't shadowed).
swaggerRouter.get('/api-docs.json', (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'application/json');
  res.status(200).send(JSON.stringify(openApiSpec));
});

// Interactive UI.
swaggerRouter.use(
  '/api-docs',
  swaggerUi.serve,
  swaggerUi.setup(openApiSpec, {
    customSiteTitle: 'InDeed API — Docs',
    swaggerOptions: { persistAuthorization: true },
  }),
);
