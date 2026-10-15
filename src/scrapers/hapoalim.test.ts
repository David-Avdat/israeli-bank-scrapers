import HapoalimScraper from './hapoalim';
import { maybeTestCompanyAPI, extendAsyncTimeout, getTestsConfig, exportTransactions } from '../tests/tests-utils';
import { CompanyTypes, SCRAPERS } from '../definitions';
import { BaseScraper } from './base-scraper';
import { BaseScraperWithBrowser, LoginResults } from './base-scraper-with-browser';
import { ScraperErrorTypes } from './errors';
import { type DeviceTrustData, type ScraperOptions } from './interface';

const COMPANY_ID = 'hapoalim'; // TODO this property should be hard-coded in the provider
const testsConfig = getTestsConfig();

describe('Hapoalim legacy scraper', () => {
  beforeAll(() => {
    extendAsyncTimeout(); // The default timeout is 5 seconds per async test, this function extends the timeout value
  });

  test('should expose login fields in scrapers constant', () => {
    expect(SCRAPERS.hapoalim).toBeDefined();
    expect(SCRAPERS.hapoalim.loginFields).toContain('userCode');
    expect(SCRAPERS.hapoalim.loginFields).toContain('password');
  });

  maybeTestCompanyAPI(COMPANY_ID, config => config.companyAPI.invalidPassword)(
    'should fail on invalid user/password"',
    async () => {
      const options = {
        ...testsConfig.options,
        companyId: COMPANY_ID,
      };

      const scraper = new HapoalimScraper(options);

      const result = await scraper.scrape({ userCode: 'e10s12', password: '3f3ss3d' });

      expect(result).toBeDefined();
      expect(result.success).toBeFalsy();
      expect(result.errorType).toBe(LoginResults.InvalidPassword);
    },
  );

  maybeTestCompanyAPI(COMPANY_ID)('should scrape transactions"', async () => {
    const options = {
      ...testsConfig.options,
      companyId: COMPANY_ID,
    };

    const scraper = new HapoalimScraper(options);
    const result = await scraper.scrape(testsConfig.credentials.hapoalim);
    expect(result).toBeDefined();
    const error = `${result.errorType || ''} ${result.errorMessage || ''}`.trim();
    expect(error).toBe('');
    expect(result.success).toBeTruthy();

    exportTransactions(COMPANY_ID, result.accounts || []);
  });
});

describe('Hapoalim 2FA (OTP)', () => {
  const OTP_FORM_SELECTOR = 'form.auth-otp-login';
  const LOGIN_URL = 'https://login.bankhapoalim.co.il/cgi-bin/poalwwwc?reqName=getLogonPage';
  const HOME_URL = 'https://login.bankhapoalim.co.il/portalserver/HomePage';

  function buildScraper(options: Partial<ScraperOptions> = {}): HapoalimScraper {
    return new HapoalimScraper({
      companyId: CompanyTypes.hapoalim,
      startDate: new Date(),
      ...options,
    } as unknown as ScraperOptions);
  }

  function scraperWithMockPage(page: Record<string, unknown>, options: Partial<ScraperOptions> = {}) {
    const scraper = buildScraper(options);
    (scraper as any).page = page;
    return scraper;
  }

  // An OTP overlay page. failAll: the overlay stays up with an inline error after every
  // submit. Otherwise the submit click accepts the code and the overlay closes.
  function buildOtpPage({ failAll = false } = {}) {
    const state = { otpForm: true };
    const inputs = Array.from({ length: 6 }, () => ({
      click: jest.fn().mockResolvedValue(undefined),
      evaluate: jest.fn().mockResolvedValue(undefined),
      type: jest.fn().mockResolvedValue(undefined),
    }));
    const page = {
      $: jest.fn((selector: string) => {
        if (selector === OTP_FORM_SELECTOR) {
          return Promise.resolve(state.otpForm ? {} : null);
        }
        return Promise.resolve(failAll ? {} : null); // OTP_ERROR_SELECTOR
      }),
      $$: jest.fn().mockResolvedValue(inputs),
      click: jest.fn(() => {
        if (!failAll) {
          state.otpForm = false;
        }
        return Promise.resolve();
      }),
      url: jest.fn(() => HOME_URL),
    };
    return { page, inputs };
  }

  describe('OTP-form detection (possibleResults condition)', () => {
    function getOtpDetector() {
      const loginOptions = buildScraper().getLoginOptions({ userCode: 'x', password: 'y' });
      const conditions = loginOptions.possibleResults[LoginResults.TwoFactorRetrieverMissing];
      expect(Array.isArray(conditions)).toBe(true);
      const detector = conditions![0];
      expect(typeof detector).toBe('function');
      return detector as (options?: { page?: any }) => Promise<boolean>;
    }

    test('detects the overlay by selector', async () => {
      const page = { $: jest.fn().mockResolvedValue({}) };
      await expect(getOtpDetector()({ page })).resolves.toBe(true);
      expect(page.$).toHaveBeenCalledWith(OTP_FORM_SELECTOR);
    });

    test('returns false when the overlay is absent', async () => {
      const page = { $: jest.fn().mockResolvedValue(null) };
      await expect(getOtpDetector()({ page })).resolves.toBe(false);
    });

    test('returns false when no page is available', async () => {
      const detector = getOtpDetector();
      await expect(detector({})).resolves.toBe(false);
      await expect(detector(undefined)).resolves.toBe(false);
    });

    test('returns false when the DOM query throws (getKeyByValue is unguarded)', async () => {
      const page = { $: jest.fn().mockRejectedValue(new Error('execution context destroyed')) };
      await expect(getOtpDetector()({ page })).resolves.toBe(false);
    });
  });

  describe('postAction', () => {
    // getCurrentUrl(page, true) is a page.evaluate of window.location.href, so the
    // evaluate mock IS the current URL.
    function buildPostActionPage() {
      const state = { otpForm: false };
      const page = {
        evaluate: jest.fn(),
        url: jest.fn(() => LOGIN_URL),
        $: jest.fn((selector: string) => Promise.resolve(selector === OTP_FORM_SELECTOR && state.otpForm ? {} : null)),
      };
      return { page, state };
    }

    test('resolves when the URL changes', async () => {
      const { page } = buildPostActionPage();
      page.evaluate.mockResolvedValueOnce(LOGIN_URL).mockResolvedValue(HOME_URL);
      const scraper = scraperWithMockPage(page);
      const postAction = scraper.getLoginOptions({ userCode: 'x', password: 'y' }).postAction;
      await expect(postAction()).resolves.toBeUndefined();
    });

    test('resolves when the OTP overlay appears without a redirect', async () => {
      const { page, state } = buildPostActionPage();
      page.evaluate.mockResolvedValue(LOGIN_URL);
      state.otpForm = true;
      const scraper = scraperWithMockPage(page);
      const postAction = scraper.getLoginOptions({ userCode: 'x', password: 'y' }).postAction;
      await expect(postAction()).resolves.toBeUndefined();
    });

    test('keeps polling when an evaluate throws mid-navigation', async () => {
      const { page } = buildPostActionPage();
      page.evaluate
        .mockResolvedValueOnce(LOGIN_URL) // initialUrl
        .mockRejectedValueOnce(new Error('Execution context was destroyed')) // poll 1 -> false
        .mockResolvedValue(HOME_URL); // poll 2 -> changed
      const scraper = scraperWithMockPage(page);
      const postAction = scraper.getLoginOptions({ userCode: 'x', password: 'y' }).postAction;
      await expect(postAction()).resolves.toBeUndefined(); // ~1s: one poll interval
      expect(page.evaluate).toHaveBeenCalledTimes(3);
    });

    test('falls back to page.url() when the initial evaluate throws', async () => {
      const { page } = buildPostActionPage();
      page.evaluate.mockRejectedValueOnce(new Error('Execution context was destroyed')).mockResolvedValue(HOME_URL);
      const scraper = scraperWithMockPage(page);
      const postAction = scraper.getLoginOptions({ userCode: 'x', password: 'y' }).postAction;
      await expect(postAction()).resolves.toBeUndefined();
      expect(page.url).toHaveBeenCalled();
    });
  });

  describe('login', () => {
    let superLogin: jest.SpyInstance;

    beforeEach(() => {
      superLogin = jest.spyOn(BaseScraperWithBrowser.prototype, 'login');
    });

    afterEach(() => {
      superLogin.mockRestore();
    });

    test('passes a successful credentials login through unchanged', async () => {
      superLogin.mockResolvedValue({ success: true });
      const result = await buildScraper().login({ userCode: 'x', password: 'y' });
      expect(result).toEqual({ success: true });
    });

    test('passes non-2FA failures through unchanged without starting the OTP flow', async () => {
      superLogin.mockResolvedValue({ success: false, errorType: ScraperErrorTypes.InvalidPassword });
      const otpCodeRetriever = jest.fn().mockResolvedValue('123456');
      const result = await buildScraper().login({ userCode: 'x', password: 'y', otpCodeRetriever });
      expect(result.errorType).toBe(ScraperErrorTypes.InvalidPassword);
      expect(otpCodeRetriever).not.toHaveBeenCalled();
    });

    test('maps the base-class throw to a completed OTP flow when the overlay is present', async () => {
      superLogin.mockRejectedValue(new Error('unexpected login result "TWO_FACTOR_RETRIEVER_MISSING"'));
      const { page, inputs } = buildOtpPage();
      const otpCodeRetriever = jest.fn().mockResolvedValue('123456');

      const result = await scraperWithMockPage(page).login({ userCode: 'x', password: 'y', otpCodeRetriever });

      expect(result).toEqual({ success: true });
      expect(otpCodeRetriever).toHaveBeenCalledWith({ attempt: 1 });
      expect(inputs[0].click).toHaveBeenCalled();
      expect(inputs[0].type).toHaveBeenCalledWith('1');
      expect(page.click).toHaveBeenCalledWith('.btn-red_1');
    });

    test('rethrows a super.login() error when the overlay is absent', async () => {
      superLogin.mockRejectedValue(new Error('navigation failed'));
      const page = { $: jest.fn().mockResolvedValue(null) };
      await expect(scraperWithMockPage(page).login({ userCode: 'x', password: 'y' })).rejects.toThrow(
        'navigation failed',
      );
    });

    test('fails fast with TwoFactorRetrieverMissing when no otpCodeRetriever is provided', async () => {
      superLogin.mockRejectedValue(new Error('unexpected login result "TWO_FACTOR_RETRIEVER_MISSING"'));
      const { page } = buildOtpPage();

      const result = await scraperWithMockPage(page).login({ userCode: 'x', password: 'y' });

      expect(result.success).toBe(false);
      expect(result.errorType).toBe(ScraperErrorTypes.TwoFactorRetrieverMissing);
      expect(page.$$).not.toHaveBeenCalled();
    });

    test('aborts with TwoFactorRetrieverMissing when the retriever returns an empty code', async () => {
      superLogin.mockRejectedValue(new Error('unexpected login result "TWO_FACTOR_RETRIEVER_MISSING"'));
      const { page } = buildOtpPage();
      const otpCodeRetriever = jest.fn().mockResolvedValue('');

      const result = await scraperWithMockPage(page).login({ userCode: 'x', password: 'y', otpCodeRetriever });

      expect(result.errorType).toBe(ScraperErrorTypes.TwoFactorRetrieverMissing);
      expect(otpCodeRetriever).toHaveBeenCalledTimes(1);
      expect(page.$$).not.toHaveBeenCalled();
    });

    test('gives up after three rejected codes', async () => {
      superLogin.mockRejectedValue(new Error('unexpected login result "TWO_FACTOR_RETRIEVER_MISSING"'));
      const { page } = buildOtpPage({ failAll: true });
      const otpCodeRetriever = jest.fn().mockResolvedValue('123456');

      const result = await scraperWithMockPage(page).login({ userCode: 'x', password: 'y', otpCodeRetriever });

      expect(result.success).toBe(false);
      expect(result.errorType).toBe(ScraperErrorTypes.General);
      expect(otpCodeRetriever).toHaveBeenCalledTimes(3);
      expect(otpCodeRetriever.mock.calls).toEqual([[{ attempt: 1 }], [{ attempt: 2 }], [{ attempt: 3 }]]);
      expect(page.click).toHaveBeenCalledTimes(3);
    });

    test('fails without further attempts when an accepted code never reaches the homepage', async () => {
      superLogin.mockRejectedValue(new Error('unexpected login result "TWO_FACTOR_RETRIEVER_MISSING"'));
      const { page } = buildOtpPage();
      page.url.mockReturnValue('https://login.bankhapoalim.co.il/SOME/ERROR/PAGE');
      const otpCodeRetriever = jest.fn().mockResolvedValue('123456');

      // This test waits out the real 10s homepage timeout by design.
      const result = await scraperWithMockPage(page).login({ userCode: 'x', password: 'y', otpCodeRetriever });

      expect(result.success).toBe(false);
      expect(result.errorType).toBe(ScraperErrorTypes.General);
      expect(otpCodeRetriever).toHaveBeenCalledTimes(1);
    }, 15000);
  });

  describe('waitForOtpOutcome', () => {
    test('treats a destroyed execution context as the overlay closing', async () => {
      const page = { $: jest.fn().mockRejectedValue(new Error('Execution context was destroyed')) };
      await expect((scraperWithMockPage(page) as any).waitForOtpOutcome()).resolves.toBe('gone');
    });
  });

  describe('device trust', () => {
    const STORED = {
      cookies: [
        {
          name: 'session',
          value: 's',
          domain: 'login.bankhapoalim.co.il',
          path: '/',
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
        },
        {
          name: 'persistent',
          value: 'p',
          domain: '.bankhapoalim.co.il',
          path: '/',
          expires: 4_000_000_000,
          httpOnly: false,
          secure: true,
          sameSite: 'None',
        },
      ],
      localStorage: { RFDEVICEID: 'xyz' },
      origin: 'https://login.bankhapoalim.co.il',
    } as DeviceTrustData;

    function buildInjectPage() {
      return {
        setCookie: jest.fn().mockResolvedValue(undefined),
        goto: jest.fn().mockResolvedValue(undefined),
        evaluate: jest.fn().mockResolvedValue(undefined),
      };
    }

    test('injects cookies with normalized expires and restores localStorage on the base URL', async () => {
      const page = buildInjectPage();
      await (scraperWithMockPage(page) as any).injectDeviceTrust(STORED);

      expect(page.setCookie).toHaveBeenCalledTimes(2);
      // expires: -1 (session cookie) is dropped; a future expiry is kept.
      expect(page.setCookie).toHaveBeenNthCalledWith(1, {
        name: 'session',
        value: 's',
        domain: 'login.bankhapoalim.co.il',
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      });
      expect(page.setCookie).toHaveBeenNthCalledWith(2, {
        name: 'persistent',
        value: 'p',
        domain: '.bankhapoalim.co.il',
        path: '/',
        httpOnly: false,
        secure: true,
        sameSite: 'None',
        expires: 4_000_000_000,
      });
      expect(page.goto).toHaveBeenCalledWith('https://login.bankhapoalim.co.il', {
        waitUntil: 'domcontentloaded',
        timeout: 15000,
      });
      expect(page.evaluate).toHaveBeenCalledWith(expect.any(Function), { RFDEVICEID: 'xyz' });
    });

    test('restores localStorage on the base URL even when the recorded origin is odd', async () => {
      const page = buildInjectPage();
      await (scraperWithMockPage(page) as any).injectDeviceTrust({ ...STORED, origin: 'https://not-the-bank.example' });
      expect(page.goto).toHaveBeenCalledWith('https://login.bankhapoalim.co.il', expect.anything());
    });

    test('keeps going when a single cookie fails to inject', async () => {
      const page = buildInjectPage();
      page.setCookie.mockRejectedValueOnce(new Error('invalid cookie'));
      await expect((scraperWithMockPage(page) as any).injectDeviceTrust(STORED)).resolves.toBeUndefined();
      expect(page.setCookie).toHaveBeenCalledTimes(2);
      expect(page.goto).toHaveBeenCalled();
    });

    test('does not throw when the localStorage navigation fails', async () => {
      const page = buildInjectPage();
      page.goto.mockRejectedValue(new Error('net::ERR_ABORTED'));
      await expect((scraperWithMockPage(page) as any).injectDeviceTrust(STORED)).resolves.toBeUndefined();
    });

    test('does nothing for empty trust data', async () => {
      const page = buildInjectPage();
      await (scraperWithMockPage(page) as any).injectDeviceTrust({ cookies: [], localStorage: {} });
      expect(page.setCookie).not.toHaveBeenCalled();
      expect(page.goto).not.toHaveBeenCalled();
      expect(page.evaluate).not.toHaveBeenCalled();
    });

    test('extracts whitelisted cookie fields, localStorage, and the origin', async () => {
      const cookies = jest.fn().mockResolvedValue([
        {
          name: 'a',
          value: 'b',
          domain: 'login.bankhapoalim.co.il',
          path: '/',
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
          size: 42, // must NOT be persisted
          session: false, // must NOT be persisted
        },
      ]);
      const page = {
        browserContext: jest.fn(() => ({ cookies })),
        evaluate: jest
          .fn()
          .mockResolvedValueOnce({ RFDEVICEID: 'xyz' })
          .mockResolvedValueOnce('https://login.bankhapoalim.co.il'),
      };

      const data = await (scraperWithMockPage(page) as any).extractDeviceTrust();

      expect(data).toEqual({
        cookies: [
          {
            name: 'a',
            value: 'b',
            domain: 'login.bankhapoalim.co.il',
            path: '/',
            expires: -1,
            httpOnly: true,
            secure: true,
            sameSite: 'Lax',
          },
        ],
        localStorage: { RFDEVICEID: 'xyz' },
        origin: 'https://login.bankhapoalim.co.il',
      });
    });

    test('initialize never throws when trust injection fails', async () => {
      const superInitialize = jest.spyOn(BaseScraperWithBrowser.prototype, 'initialize').mockResolvedValue(undefined);
      const inject = jest
        .spyOn(HapoalimScraper.prototype as any, 'injectDeviceTrust')
        .mockRejectedValue(new Error('boom'));
      try {
        const scraper = buildScraper({ deviceTrustData: { cookies: [], localStorage: {} } } as Partial<ScraperOptions>);
        await expect(scraper.initialize()).resolves.toBeUndefined();
        expect(inject).toHaveBeenCalled();
      } finally {
        inject.mockRestore();
        superInitialize.mockRestore();
      }
    });

    test('terminate extracts trust data before the base cleanups close the page', async () => {
      const events: string[] = [];
      const page = {
        browserContext: jest.fn(() => ({
          cookies: jest.fn(() => {
            events.push('cookies');
            return Promise.resolve([]);
          }),
        })),
        evaluate: jest.fn().mockResolvedValueOnce({}).mockResolvedValueOnce('https://login.bankhapoalim.co.il'),
      };
      const scraper = scraperWithMockPage(page);
      (scraper as any).cleanups = [
        () => {
          events.push('cleanup');
          return Promise.resolve();
        },
      ];

      await scraper.terminate(true);

      expect(events).toEqual(['cookies', 'cleanup']);
      expect((scraper as any).deviceTrustData).toBeDefined();
    });

    test('terminate skips extraction after a failed scrape', async () => {
      const page = { browserContext: jest.fn() };
      const scraper = scraperWithMockPage(page);

      await scraper.terminate(false);

      expect(page.browserContext).not.toHaveBeenCalled();
      expect((scraper as any).deviceTrustData).toBeUndefined();
    });

    test('terminate swallows extraction failures', async () => {
      const page = {
        browserContext: jest.fn(() => {
          throw new Error('page already closed');
        }),
      };
      const scraper = scraperWithMockPage(page);

      await expect(scraper.terminate(true)).resolves.toBeUndefined();
      expect((scraper as any).deviceTrustData).toBeUndefined();
    });
  });

  describe('scrape', () => {
    let superScrape: jest.SpyInstance;

    beforeEach(() => {
      superScrape = jest.spyOn(BaseScraper.prototype, 'scrape');
    });

    afterEach(() => {
      superScrape.mockRestore();
    });

    test('attaches device trust data on success', async () => {
      const scraper = buildScraper();
      const trust = { cookies: [], localStorage: { RFDEVICEID: 'xyz' }, origin: 'https://login.bankhapoalim.co.il' };
      superScrape.mockImplementation(() => {
        (scraper as any).deviceTrustData = trust; // what terminate() does in a real scrape
        return Promise.resolve({ success: true, accounts: [] });
      });

      const result = await scraper.scrape({ userCode: 'x', password: 'y' });

      expect(result.deviceTrustData).toEqual(trust);
    });

    test('omits device trust data on failure', async () => {
      const scraper = buildScraper();
      superScrape.mockImplementation(() => {
        (scraper as any).deviceTrustData = { cookies: [], localStorage: {} };
        return Promise.resolve({ success: false, errorType: ScraperErrorTypes.InvalidPassword });
      });

      const result = await scraper.scrape({ userCode: 'x', password: 'y' });

      expect(result.deviceTrustData).toBeUndefined();
    });
  });
});
