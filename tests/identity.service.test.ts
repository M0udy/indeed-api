import {
  IdentityService,
  MockIdswyftClient,
  normaliseNrc,
  type IdswyftClient,
  type IdswyftVerifyResponse,
} from '../src/services/identity.service';

/**
 * The Idswyft provider call is injected, so these tests exercise NRC validation,
 * response mapping, and error handling deterministically without any network.
 */

/** Build a fake provider client returning a fixed response. */
function fakeClient(response: IdswyftVerifyResponse): IdswyftClient {
  return { verify: jest.fn().mockResolvedValue(response) };
}

const VALID_NRC = 'ZM0123456789';

describe('normaliseNrc', () => {
  it('accepts a well-formed NRC', () => {
    expect(normaliseNrc('ZM0123456789')).toBe('ZM0123456789');
  });

  it('uppercases and strips spaces/dashes', () => {
    expect(normaliseNrc(' zm-0123456789 ')).toBe('ZM0123456789');
  });

  it('rejects a malformed NRC', () => {
    expect(normaliseNrc('0123456789')).toBeNull(); // missing ZM
    expect(normaliseNrc('ZM12345')).toBeNull(); // too short
    expect(normaliseNrc('ZMABCDEFGHIJ')).toBeNull(); // non-numeric
  });
});

describe('IdentityService.verifyIdentity', () => {
  it('verifies a valid NRC and maps the provider response', async () => {
    const client = fakeClient({
      verified: true,
      confidence: 0.95,
      full_name: 'John Banda',
      date_of_birth: '1988-04-12',
    });
    const service = new IdentityService(client);

    const result = await service.verifyIdentity(VALID_NRC);

    expect(client.verify).toHaveBeenCalledWith({ nrc: VALID_NRC });
    expect(result).toMatchObject({
      verified: true,
      confidence_score: 0.95,
      nrc: VALID_NRC,
      name: 'John Banda',
      date_of_birth: '1988-04-12',
      photo_match: null, // no photo supplied
    });
    expect(typeof result?.verified_at).toBe('string');
  });

  it('returns null for an invalid NRC without calling the provider', async () => {
    const client = fakeClient({ verified: true });
    const service = new IdentityService(client);

    const result = await service.verifyIdentity('NOT-AN-NRC');

    expect(result).toBeNull();
    expect(client.verify).not.toHaveBeenCalled();
  });

  it('includes photo_match when a photo URL is provided', async () => {
    const client = fakeClient({
      verified: true,
      confidence: 0.9,
      full_name: 'Jane Phiri',
      date_of_birth: '1991-09-01',
      photo_match: true,
    });
    const service = new IdentityService(client);

    const result = await service.verifyIdentity(VALID_NRC, 'https://cdn.example.com/face.jpg');

    expect(client.verify).toHaveBeenCalledWith({
      nrc: VALID_NRC,
      photoUrl: 'https://cdn.example.com/face.jpg',
    });
    expect(result?.photo_match).toBe(true);
  });

  it('maps an unsuccessful verification', async () => {
    const client = fakeClient({ verified: false, confidence: 0.1 });
    const service = new IdentityService(client);

    const result = await service.verifyIdentity(VALID_NRC);

    expect(result).toMatchObject({ verified: false, confidence_score: 0.1, name: null });
  });

  it('returns null when the provider throws', async () => {
    const client: IdswyftClient = { verify: jest.fn().mockRejectedValue(new Error('503')) };
    const service = new IdentityService(client);

    const result = await service.verifyIdentity(VALID_NRC);
    expect(result).toBeNull();
  });

  it('clamps an out-of-range confidence into [0, 1]', async () => {
    const client = fakeClient({ verified: true, confidence: 5 });
    const service = new IdentityService(client);

    const result = await service.verifyIdentity(VALID_NRC);
    expect(result?.confidence_score).toBe(1);
  });
});

describe('MockIdswyftClient', () => {
  const service = new IdentityService(new MockIdswyftClient());

  it('verifies NRCs deterministically (even last digit → verified)', async () => {
    const ok = await service.verifyIdentity('ZM0123456780'); // ends in 0
    expect(ok?.verified).toBe(true);
    expect(ok?.name).not.toBeNull();

    const notOk = await service.verifyIdentity('ZM0123456781'); // ends in 1
    expect(notOk?.verified).toBe(false);
    expect(notOk?.name).toBeNull();
  });

  it('only reports photo_match when a photo is supplied', async () => {
    const withoutPhoto = await service.verifyIdentity('ZM0123456780');
    expect(withoutPhoto?.photo_match).toBeNull();

    const withPhoto = await service.verifyIdentity('ZM0123456780', 'https://x/y.jpg');
    expect(withPhoto?.photo_match).toBe(true);
  });
});
