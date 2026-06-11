import { Router } from 'express';
import { propertyRouter } from '../property.routes';
import { ocrRouter } from '../ocr.routes';
import { identityRouter } from '../identity.routes';
import { rulesRouter } from '../rules.routes';
import { satelliteRouter } from '../satellite.routes';

/**
 * Single entry point for everything under `/properties`.
 *
 * Aggregates the marketplace CRUD router with each per-feature sub-router
 * (OCR, identity, fraud rules, satellite) so `app.ts` mounts one router instead
 * of five. Each feature keeps its own route file (with its validation and
 * limiters) co-located; this index just composes them.
 *
 * Routes exposed (all relative to `/properties`):
 *   - CRUD:    POST /, GET /, GET /:id, GET /user/:userId, PUT /:id, DELETE /:id
 *   - Upload:  POST /:id/upload
 *   - Fraud:   POST /:id/analyze          (combined rules + Claude score)
 *   - OCR:     POST /:id/ocr
 *   - Identity:POST /:id/verify-identity
 *   - Rules:   POST /:id/check-rules
 *   - Satellite: POST /:id/verify-satellite
 */
export const propertiesRouter = Router();

propertiesRouter.use(propertyRouter);
propertiesRouter.use(ocrRouter);
propertiesRouter.use(identityRouter);
propertiesRouter.use(rulesRouter);
propertiesRouter.use(satelliteRouter);
