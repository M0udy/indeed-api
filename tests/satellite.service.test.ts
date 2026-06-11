import Anthropic from '@anthropic-ai/sdk';
import {
  ClaudeVisionAnalyzer,
  MockSatelliteImageProvider,
  SatelliteService,
  type SatelliteImage,
  type SatelliteImageProvider,
  type SatelliteVerdict,
  type SatelliteVisionAnalyzer,
} from '../src/services/satellite.service';

/**
 * The image provider and vision analyzer are injected, so the orchestration is
 * exercised deterministically without any network access.
 */

const IMAGE: SatelliteImage = {
  imageUrl: 'https://satellite.test/img.png',
  imageBase64: 'AAAA',
  mediaType: 'image/png',
};

function fakeProvider(image: SatelliteImage | null = IMAGE): SatelliteImageProvider {
  return { fetchImage: jest.fn().mockResolvedValue(image) };
}

function fakeVision(verdict: SatelliteVerdict): SatelliteVisionAnalyzer {
  return { analyze: jest.fn().mockResolvedValue(verdict) };
}

describe('SatelliteService.verifySatellite', () => {
  it('returns a verified result when the imagery matches', async () => {
    const vision = fakeVision({ matches: true, confidence: 0.88, reasoning: 'Open land matches plot' });
    const service = new SatelliteService(fakeProvider(), vision);

    const result = await service.verifySatellite(-15.4, 28.3, 'Vacant residential plot');

    expect(result).toMatchObject({
      verified: true,
      confidence_score: 0.88,
      image_url: 'https://satellite.test/img.png',
      matches_description: true,
      latitude: -15.4,
      longitude: 28.3,
    });
    expect(result?.analysis).toBe('Open land matches plot');
    expect(typeof result?.verified_at).toBe('string');
  });

  it('returns a non-verified result when the imagery does not match', async () => {
    const vision = fakeVision({ matches: false, confidence: 0.2, reasoning: 'Image shows dense buildings' });
    const service = new SatelliteService(fakeProvider(), vision);

    const result = await service.verifySatellite(-15.4, 28.3, 'Vacant 5-acre farm');
    expect(result?.verified).toBe(false);
    expect(result?.matches_description).toBe(false);
  });

  it('returns null when no satellite image is available', async () => {
    const vision = fakeVision({ matches: true, confidence: 1, reasoning: '' });
    const service = new SatelliteService(fakeProvider(null), vision);

    const result = await service.verifySatellite(-15.4, 28.3, 'plot');
    expect(result).toBeNull();
    expect(vision.analyze).not.toHaveBeenCalled();
  });

  it('returns null when the image provider throws', async () => {
    const provider: SatelliteImageProvider = {
      fetchImage: jest.fn().mockRejectedValue(new Error('network down')),
    };
    const service = new SatelliteService(provider, fakeVision({ matches: true, confidence: 1, reasoning: '' }));

    expect(await service.verifySatellite(-15.4, 28.3, 'plot')).toBeNull();
  });

  it('returns null when vision analysis throws', async () => {
    const vision: SatelliteVisionAnalyzer = {
      analyze: jest.fn().mockRejectedValue(new Error('vision error')),
    };
    const service = new SatelliteService(fakeProvider(), vision);

    expect(await service.verifySatellite(-15.4, 28.3, 'plot')).toBeNull();
  });

  it('returns null for out-of-range coordinates without calling providers', async () => {
    const provider = fakeProvider();
    const vision = fakeVision({ matches: true, confidence: 1, reasoning: '' });
    const service = new SatelliteService(provider, vision);

    expect(await service.verifySatellite(120, 28.3, 'plot')).toBeNull(); // bad lat
    expect(await service.verifySatellite(-15.4, 999, 'plot')).toBeNull(); // bad lng
    expect(provider.fetchImage).not.toHaveBeenCalled();
  });

  it('clamps an out-of-range confidence into [0, 1]', async () => {
    const service = new SatelliteService(fakeProvider(), fakeVision({ matches: true, confidence: 5, reasoning: 'x' }));
    const result = await service.verifySatellite(-15.4, 28.3, 'plot');
    expect(result?.confidence_score).toBe(1);
  });

  it('passes the image and description through to the analyzer', async () => {
    const vision = fakeVision({ matches: true, confidence: 0.7, reasoning: 'ok' });
    const service = new SatelliteService(fakeProvider(), vision);
    await service.verifySatellite(-15.4, 28.3, 'Lakeside cottage');
    expect(vision.analyze).toHaveBeenCalledWith(IMAGE, 'Lakeside cottage');
  });
});

describe('MockSatelliteImageProvider', () => {
  it('returns a deterministic PNG image for any coordinates', async () => {
    const provider = new MockSatelliteImageProvider();
    const image = await provider.fetchImage(-15.4, 28.3);
    expect(image?.mediaType).toBe('image/png');
    expect(image?.imageUrl).toContain('-15.4,28.3');
    expect(typeof image?.imageBase64).toBe('string');
  });
});

describe('ClaudeVisionAnalyzer', () => {
  it('extracts the structured verdict from a tool_use response', async () => {
    const create = jest.fn().mockResolvedValue({
      content: [
        {
          type: 'tool_use',
          name: 'record_satellite_match',
          input: { matches: true, confidence: 0.9, reasoning: 'Matches terrain' },
        },
      ],
    });
    const anthropic = { messages: { create } } as unknown as Anthropic;
    const analyzer = new ClaudeVisionAnalyzer(anthropic);

    const verdict = await analyzer.analyze(IMAGE, 'Open plot');

    expect(verdict).toEqual({ matches: true, confidence: 0.9, reasoning: 'Matches terrain' });
    // The image is sent as a base64 image block.
    const sent = create.mock.calls[0][0];
    expect(sent.messages[0].content[0]).toMatchObject({ type: 'image', source: { type: 'base64' } });
  });

  it('throws when the model returns no tool_use verdict', async () => {
    const create = jest.fn().mockResolvedValue({ content: [{ type: 'text', text: 'no tool' }] });
    const anthropic = { messages: { create } } as unknown as Anthropic;
    const analyzer = new ClaudeVisionAnalyzer(anthropic);

    await expect(analyzer.analyze(IMAGE, 'plot')).rejects.toThrow();
  });
});
