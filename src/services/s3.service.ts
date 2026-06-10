import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { config } from '../config/env';
import { logger } from '../utils/logger';
import { UpstreamServiceError, ValidationError } from '../utils/errors';

/**
 * AWS S3 storage for property images and deed documents.
 *
 * Files are namespaced under `properties/<propertyId>/<uuid>.<ext>` so a single
 * bucket cleanly separates each listing's assets.
 */

/** Allowed upload MIME types → file purpose. */
const ALLOWED_MIME_TYPES: Readonly<Record<string, 'image' | 'document'>> = {
  'image/jpeg': 'image',
  'image/png': 'image',
  'image/webp': 'image',
  'application/pdf': 'document',
};

const MAX_FILE_BYTES = 15 * 1024 * 1024; // 15 MB

export interface UploadResult {
  /** Public-style S3 URI of the stored object. */
  url: string;
  /** S3 object key. */
  key: string;
  /** Whether the file was classified as an image or a deed document. */
  kind: 'image' | 'document';
}

export class S3Service {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly region: string;

  constructor(client?: S3Client) {
    this.region = config.aws.region;
    this.bucket = config.aws.bucket;
    this.client =
      client ??
      new S3Client({
        region: this.region,
        credentials: {
          accessKeyId: config.aws.accessKeyId,
          secretAccessKey: config.aws.secretAccessKey,
        },
      });
  }

  /**
   * Validate then upload a file buffer to S3.
   *
   * @throws {ValidationError}     for disallowed types or oversized files.
   * @throws {UpstreamServiceError} if S3 rejects the upload.
   */
  async uploadPropertyFile(
    propertyId: string,
    file: { buffer: Buffer; originalname: string; mimetype: string; size: number },
  ): Promise<UploadResult> {
    const kind = ALLOWED_MIME_TYPES[file.mimetype];
    if (!kind) {
      throw new ValidationError(
        `Unsupported file type "${file.mimetype}". Allowed: ${Object.keys(ALLOWED_MIME_TYPES).join(', ')}`,
      );
    }
    if (file.size > MAX_FILE_BYTES) {
      throw new ValidationError(`File exceeds the ${MAX_FILE_BYTES / (1024 * 1024)}MB limit`);
    }

    const ext = extname(file.originalname).toLowerCase() || (kind === 'document' ? '.pdf' : '.jpg');
    const key = `properties/${propertyId}/${randomUUID()}${ext}`;

    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: file.buffer,
          ContentType: file.mimetype,
        }),
      );
    } catch (err) {
      logger.error('S3 upload failed', {
        key,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new UpstreamServiceError('Failed to store file');
    }

    const url = `https://${this.bucket}.s3.${this.region}.amazonaws.com/${key}`;
    logger.info('File uploaded to S3', { key, kind });
    return { url, key, kind };
  }
}

/** Shared singleton used by controllers. */
export const s3Service = new S3Service();
