import { OcrService, type OcrRecognizer } from '../src/services/ocr.service';

/**
 * The Tesseract step is injected, so these tests exercise the parsing and
 * scoring logic deterministically without running the native OCR engine.
 */

/** A realistic, well-formed deed transcript. */
const CLEAR_DEED_TEXT = [
  'REPUBLIC OF ZAMBIA — CERTIFICATE OF TITLE',
  'Deed Number: ZM-2024-001234',
  'Property Address: 123 Main Street, Lusaka',
  'Seller: John Doe',
  'Buyer: Jane Smith',
  'Transaction Date: 2024-03-15',
  'Amount in words: One Million Kwacha Only',
  'Amount in numbers: ZMW 1,000,000.00',
  'Coordinates: -15.387526, 28.322817',
].join('\n');

/** Build a fake recognizer that returns fixed text + confidence. */
function fakeRecognizer(text: string, confidence: number): OcrRecognizer {
  return jest.fn().mockResolvedValue({ text, confidence });
}

describe('OcrService.parseDeedImage', () => {
  const image = Buffer.from('fake-image-bytes');

  it('parses all fields from a clear deed image', async () => {
    const service = new OcrService(fakeRecognizer(CLEAR_DEED_TEXT, 93));
    const result = await service.parseDeedImage(image);

    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      deed_number: 'ZM-2024-001234',
      property_address: '123 Main Street, Lusaka',
      seller_name: 'John Doe',
      buyer_name: 'Jane Smith',
      transaction_date: '2024-03-15',
      amount_in_words: 'One Million Kwacha Only',
      amount_in_numbers: 1_000_000,
      location_coordinates: { latitude: -15.387526, longitude: 28.322817 },
    });
  });

  it('produces a high confidence score when OCR is clean and fields are complete', async () => {
    const service = new OcrService(fakeRecognizer(CLEAR_DEED_TEXT, 95));
    const result = await service.parseDeedImage(image);

    expect(result).not.toBeNull();
    expect(result?.confidence_score).toBeGreaterThan(0.85);
    expect(result?.confidence_score).toBeLessThanOrEqual(1);
  });

  it('returns null when OCR yields no text (blank/blurry image)', async () => {
    const service = new OcrService(fakeRecognizer('   \n  ', 5));
    const result = await service.parseDeedImage(image);
    expect(result).toBeNull();
  });

  it('returns null when the recognizer throws (unreadable image)', async () => {
    const recognizer: OcrRecognizer = jest.fn().mockRejectedValue(new Error('decode failed'));
    const service = new OcrService(recognizer);
    const result = await service.parseDeedImage(image);
    expect(result).toBeNull();
  });

  it('returns null for an empty image buffer without calling OCR', async () => {
    const recognizer = jest.fn();
    const service = new OcrService(recognizer as unknown as OcrRecognizer);
    const result = await service.parseDeedImage(Buffer.alloc(0));
    expect(result).toBeNull();
    expect(recognizer).not.toHaveBeenCalled();
  });

  it('handles missing fields by returning null for them and a lower confidence', async () => {
    const sparseText = ['Deed Number: ZM-2023-009876', 'Some unrelated text on the page'].join('\n');
    const service = new OcrService(fakeRecognizer(sparseText, 90));
    const result = await service.parseDeedImage(image);

    expect(result).not.toBeNull();
    expect(result?.deed_number).toBe('ZM-2023-009876');
    expect(result?.seller_name).toBeNull();
    expect(result?.buyer_name).toBeNull();
    expect(result?.amount_in_words).toBeNull();
    expect(result?.location_coordinates).toBeNull();
    // Few fields found → confidence should be well below a complete parse.
    expect(result?.confidence_score).toBeLessThan(0.7);
  });

  it('normalises spaced deed numbers to the canonical format', async () => {
    const service = new OcrService(fakeRecognizer('Title Number ZM 2024 005678', 88));
    const result = await service.parseDeedImage(image);
    expect(result?.deed_number).toBe('ZM-2024-005678');
  });

  it('parses amounts with currency markers and thousands separators', async () => {
    const service = new OcrService(fakeRecognizer('Amount in numbers: USD 2,500,000', 80));
    const result = await service.parseDeedImage(image);
    expect(result?.amount_in_numbers).toBe(2_500_000);
  });

  it('ignores out-of-range coordinates', async () => {
    const service = new OcrService(fakeRecognizer('Coordinates: 999.123456, 28.322817', 85));
    const result = await service.parseDeedImage(image);
    expect(result?.location_coordinates).toBeNull();
  });

  it('always returns a confidence score within [0, 1]', async () => {
    const service = new OcrService(fakeRecognizer(CLEAR_DEED_TEXT, 150)); // clamp test
    const result = await service.parseDeedImage(image);
    expect(result?.confidence_score).toBeGreaterThanOrEqual(0);
    expect(result?.confidence_score).toBeLessThanOrEqual(1);
  });
});
