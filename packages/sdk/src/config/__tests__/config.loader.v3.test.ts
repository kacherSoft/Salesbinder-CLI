import fs from 'node:fs';

jest.mock('node:fs');

const mockedFs = jest.mocked(fs);

describe('loadV3Config', () => {
  let loadConfig: typeof import('../config.loader.js').loadConfig;
  let loadV3Config: typeof import('../config.loader.js').loadV3Config;

  beforeAll(async () => {
    ({ loadConfig, loadV3Config } = await import('../config.loader.js'));
  });

  beforeEach(() => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.statSync.mockReturnValue({ mode: 0o100600 } as fs.Stats);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify({
      defaultAccount: 'v3-only',
      accounts: {
        'v3-only': { subdomain: 'example', v3ApiKey: 'v3-secret', apiVersion: '3.0' },
        legacy: { subdomain: 'legacy', apiVersion: '2.0' },
      },
    }));
  });

  it('loads V3-only account without requiring or returning a V2 key', () => {
    const account = loadV3Config('v3-only');
    expect(account).toEqual({ subdomain: 'example', v3ApiKey: 'v3-secret', apiVersion: '3.0' });
  });

  it('allows status identity loading when the account has no V3 key', () => {
    mockedFs.readFileSync.mockReturnValue(JSON.stringify({ defaultAccount: 'legacy', accounts: { legacy: { subdomain: 'legacy', apiVersion: '2.0' } } }));
    expect(loadV3Config('legacy')).toEqual({ subdomain: 'legacy', apiVersion: '2.0' });
  });

  it('keeps legacy loadConfig strict about V2 credentials', () => {
    expect(() => loadConfig('legacy')).toThrow('missing apiKey');
  });

  it('rejects invalid V3 key shape', () => {
    mockedFs.readFileSync.mockReturnValue(JSON.stringify({ defaultAccount: 'bad', accounts: { bad: { subdomain: 'bad', v3ApiKey: ' ' } } }));
    expect(() => loadV3Config('bad')).toThrow('invalid v3ApiKey');
  });
});
