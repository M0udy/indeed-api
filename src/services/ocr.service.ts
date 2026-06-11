import { createWorker } from 'tesseract.js';
import { logger } from '../utils/logger';
import type { DeedCoordinates, DeedData } from '../types';

/**
 * OCR-based deed parsing.
 *
 * A deed image is run through Tesseract to produce raw text, which is then
 * mined with a set of label- and pattern-based extractors to populate a
 * strongly-typed {@link DeedData} record. The whole pipeline is wrapped so that
 * any failure (unreadable image, OCR crash) resolves to `null` rather than
 * throwing — callers can treat `null` as "could not parse".
 *
 * The Tesseract step is injected as an {@link OcrRecognizer}, so tests (and
 * alternative OCR backends) can supply their own implementation without running
 * the native engine.
 */

/** Low-level OCR step: image buffer → recognised text + 0–100 confidence. */
export type OcrRecognizer = (image: Buffer) => Promise<{ text: string; confidence: number }>;

/** The deed fields we attempt to extract (used for completeness scoring). */
const TARGET_FIELDS = [
  'deed_number',
  'property_address',
  'seller_name',
  'buyer_name',
  'transaction_date',
  'amount_in_words',
  'amount_in_numbers',
  'location_coordinates',
] as const;

/** Default recognizer backed by Tesseract.js (English). */
async function tesseractRecognizer(image: Buffer): Promise<{ text: string; confidence: number }> {
  const worker = await createWorker();
  try {
    await worker.loadLanguage('eng');
    await worker.initialize('eng');
    const { data } = await worker.recognize(image);
    return { text: data.text, confidence: data.confidence };
  } finally {
    await worker.terminate();
  }
}

export class OcrService {
  private readonly recognize: OcrRecognizer;

  constructor(recognizer: OcrRecognizer = tesseractRecognizer) {
    this.recognize = recognizer;
  }

  /**
   * Parse a deed image into structured {@link DeedData}.
   *
   * @param imageBuffer Raw bytes of a JPG/PNG deed image.
   * @returns The parsed deed data, or `null` if OCR/parsing failed entirely.
   */
  async parseDeedImage(imageBuffer: Buffer): Promise<DeedData | null> {
    if (imageBuffer.length === 0) {
      logger.warn('OCR called with an empty image buffer');
      return null;
    }

    let text: string;
    let ocrConfidence: number;
    try {
      const result = await this.recognize(imageBuffer);
      text = result.text ?? '';
      ocrConfidence = Number.isFinite(result.confidence) ? result.confidence : 0;
    } catch (err) {
      logger.error('OCR recognition failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }

    if (text.trim().length === 0) {
      logger.warn('OCR produced no text from the image');
      return null;
    }

    const deedData = this.extractFields(text, ocrConfidence);
    logger.info('Deed parsed', {
      confidence: deedData.confidence_score,
      foundDeedNumber: deedData.deed_number !== null,
    });
    return deedData;
  }

  /** Run every field extractor over the OCR text and assemble the record. */
  private extractFields(text: string, ocrConfidence: number): DeedData {
    const deed_number = this.extractDeedNumber(text);
    const property_address = this.extractLabeled(text, [
      'property address',
      'address of property',
      'address',
      'property',
    ]);
    const seller_name = this.extractLabeled(text, ['seller', 'vendor', 'grantor', 'transferor']);
    const buyer_name = this.extractLabeled(text, ['buyer', 'purchaser', 'grantee', 'transferee']);
    const transaction_date = this.extractDate(text);
    const amount_in_words = this.extractLabeled(text, [
      'amount in words',
      'sum in words',
      'in words',
    ]);
    const amount_in_numbers = this.extractAmount(text);
    const location_coordinates = this.extractCoordinates(text);

    const partial: Omit<DeedData, 'confidence_score' | 'raw_text'> = {
      deed_number,
      property_address,
      seller_name,
      buyer_name,
      transaction_date,
      amount_in_words,
      amount_in_numbers,
      location_coordinates,
    };

    return {
      ...partial,
      confidence_score: this.computeConfidence(ocrConfidence, partial),
      raw_text: text,
    };
  }

  // ── field extractors ──────────────────────────────────────

  /**
   * Find a deed number. Prefers a labeled value ("Deed Number: …"); otherwise
   * falls back to the canonical `ZM-2024-001234` pattern (two letters, year,
   * serial).
   */
  private extractDeedNumber(text: string): string | null {
    const labeled = this.extractLabeled(text, ['deed number', 'deed no', 'deed', 'title number']);
    if (labeled) {
      const match = labeled.match(/[A-Z]{2}[-\s]?\d{4}[-\s]?\d{3,6}/i);
      if (match) return this.normaliseDeedNumber(match[0]);
      return labeled;
    }
    const pattern = text.match(/\b[A-Z]{2}[-\s]?\d{4}[-\s]?\d{3,6}\b/);
    return pattern ? this.normaliseDeedNumber(pattern[0]) : null;
  }

  /** Canonicalise a deed number to `XX-YYYY-NNNNNN`. */
  private normaliseDeedNumber(raw: string): string {
    const cleaned = raw.toUpperCase().replace(/\s+/g, '-').replace(/-+/g, '-');
    const parts = cleaned.match(/([A-Z]{2})-?(\d{4})-?(\d{3,6})/);
    return parts ? `${parts[1]}-${parts[2]}-${parts[3]}` : cleaned;
  }

  /**
   * Extract the text following one of the given labels, on the same line.
   * Labels are tried in order; the first match wins.
   */
  private extractLabeled(text: string, labels: ReadonlyArray<string>): string | null {
    for (const label of labels) {
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`${escaped}\\s*[:\\-]?\\s*([^\\n\\r]+)`, 'i');
      const match = text.match(regex);
      if (match && match[1]) {
        const value = match[1].trim().replace(/\s{2,}/g, ' ');
        if (value.length > 0) return value;
      }
    }
    return null;
  }

  /** Extract a transaction date in common formats; returns the raw string. */
  private extractDate(text: string): string | null {
    const labeled = this.extractLabeled(text, [
      'transaction date',
      'date of transaction',
      'dated',
      'date',
    ]);
    const haystack = labeled ?? text;

    const patterns: RegExp[] = [
      /\b\d{4}-\d{2}-\d{2}\b/, // 2024-01-31
      /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/, // 31/01/2024
      /\b\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]+,?\s+\d{4}\b/, // 31st January, 2024
      /\b[A-Za-z]+\s+\d{1,2},?\s+\d{4}\b/, // January 31, 2024
    ];
    for (const pattern of patterns) {
      const match = haystack.match(pattern);
      if (match) return match[0].trim();
    }
    return null;
  }

  /**
   * Extract a monetary amount as a number. Handles currency markers (ZMW, K,
   * USD, $) and thousands separators.
   */
  private extractAmount(text: string): number | null {
    const labeled = this.extractLabeled(text, [
      'amount in numbers',
      'amount in figures',
      'amount',
      'price',
      'consideration',
      'sum of',
    ]);
    const haystack = labeled ?? text;

    // Look for a currency-prefixed or standalone number with optional decimals.
    const match = haystack.match(
      /(?:ZMW|USD|US\$|\$|K)?\s*([0-9]{1,3}(?:[,\s][0-9]{3})+(?:\.[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2})?)/i,
    );
    if (!match || !match[1]) return null;

    const numeric = Number(match[1].replace(/[,\s]/g, ''));
    return Number.isFinite(numeric) ? numeric : null;
  }

  /** Extract latitude/longitude when present and within valid ranges. */
  private extractCoordinates(text: string): DeedCoordinates | null {
    const match = text.match(/(-?\d{1,2}\.\d{3,})\s*[,;]\s*(-?\d{1,3}\.\d{3,})/);
    if (!match || !match[1] || !match[2]) return null;

    const latitude = Number(match[1]);
    const longitude = Number(match[2]);
    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      latitude < -90 ||
      latitude > 90 ||
      longitude < -180 ||
      longitude > 180
    ) {
      return null;
    }
    return { latitude, longitude };
  }

  // ── confidence ────────────────────────────────────────────

  /**
   * Combine raw OCR confidence (0–100) with field-completeness into a single
   * 0–1 score. Even perfect OCR on a blank form should not score 1.0, so the
   * completeness ratio carries half the weight.
   */
  private computeConfidence(
    ocrConfidence: number,
    fields: Omit<DeedData, 'confidence_score' | 'raw_text'>,
  ): number {
    const base = Math.max(0, Math.min(100, ocrConfidence)) / 100;

    const found = TARGET_FIELDS.reduce((count, key) => {
      const value = fields[key];
      return value !== null && value !== undefined ? count + 1 : count;
    }, 0);
    const completeness = found / TARGET_FIELDS.length;

    const score = base * 0.5 + base * completeness * 0.5;
    return Math.round(Math.max(0, Math.min(1, score)) * 100) / 100;
  }
}

/** Shared singleton used by controllers. */
export const ocrService = new OcrService();
