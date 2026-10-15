import moment from 'moment';
import { type CookieData, type Page } from 'puppeteer';
import { randomUUID } from 'crypto';
import { getDebug } from '../helpers/debug';
import { fetchGetWithinPage, fetchPostWithinPage } from '../helpers/fetch';
import { getCurrentUrl } from '../helpers/navigation';
import { sleep, waitUntil } from '../helpers/waiting';
import { type Transaction, TransactionStatuses, TransactionTypes, type TransactionsAccount } from '../transactions';
import { BaseScraperWithBrowser, LoginResults, type PossibleLoginResults } from './base-scraper-with-browser';
import { ScraperProgressTypes } from '../definitions';
import { ScraperErrorTypes } from './errors';
import {
  type DeviceTrustData,
  type ScraperLoginResult,
  type ScraperOptions,
  type ScraperScrapingResult,
} from './interface';
import { getRawTransaction } from '../helpers/transactions';

const debug = getDebug('hapoalim');

const DATE_FORMAT = 'YYYYMMDD';

// eslint-disable-next-line @typescript-eslint/no-namespace
declare namespace window {
  const bnhpApp: any;
  const localStorage: Storage;
  const location: Location;
}

interface ScrapedTransaction {
  serialNumber?: number;
  activityDescription?: string;
  eventAmount: number;
  valueDate?: string;
  eventDate?: string;
  referenceNumber?: number;
  ScrapedTransaction?: string;
  eventActivityTypeCode: number;
  currentBalance: number;
  pfmDetails: string;
  beneficiaryDetailsData?: {
    partyHeadline?: string;
    partyName?: string;
    messageHeadline?: string;
    messageDetail?: string;
  };
  additionalInformation?: unknown;
}

interface ScrapedPfmTransaction {
  transactionNumber: number;
}

type FetchedAccountData = {
  bankNumber: string;
  accountNumber: string;
  branchNumber: string;
  accountClosingReasonCode: number;
}[];

type FetchedAccountTransactionsData = {
  transactions: ScrapedTransaction[];
};

type BalanceAndCreditLimit = {
  creditLimitAmount: number;
  creditLimitDescription: string;
  creditLimitUtilizationAmount: number;
  creditLimitUtilizationExistanceCode: number;
  creditLimitUtilizationPercent: number;
  currentAccountLimitsAmount: number;
  currentBalance: number;
  withdrawalBalance: number;
};

function convertTransactions(txns: ScrapedTransaction[], options?: ScraperOptions): Transaction[] {
  return txns.map(txn => {
    const isOutbound = txn.eventActivityTypeCode === 2;

    let memo = '';
    if (txn.beneficiaryDetailsData) {
      const { partyHeadline, partyName, messageHeadline, messageDetail } = txn.beneficiaryDetailsData;
      const memoLines: string[] = [];
      if (partyHeadline) {
        memoLines.push(partyHeadline);
      }

      if (partyName) {
        memoLines.push(`${partyName}.`);
      }

      if (messageHeadline) {
        memoLines.push(messageHeadline);
      }

      if (messageDetail) {
        memoLines.push(`${messageDetail}.`);
      }

      if (memoLines.length) {
        memo = memoLines.join(' ');
      }
    }

    const result: Transaction = {
      type: TransactionTypes.Normal,
      identifier: txn.referenceNumber,
      date: moment(txn.eventDate, DATE_FORMAT).toISOString(),
      processedDate: moment(txn.valueDate, DATE_FORMAT).toISOString(),
      originalAmount: isOutbound ? -txn.eventAmount : txn.eventAmount,
      originalCurrency: 'ILS',
      chargedAmount: isOutbound ? -txn.eventAmount : txn.eventAmount,
      description: txn.activityDescription || '',
      status: txn.serialNumber === 0 ? TransactionStatuses.Pending : TransactionStatuses.Completed,
      memo,
    };

    if (options?.includeRawTransaction) {
      result.rawTransaction = getRawTransaction(txn);
    }

    return result;
  });
}

async function getRestContext(page: Page) {
  await waitUntil(() => {
    return page.evaluate(() => !!window.bnhpApp);
  }, 'waiting for app data load');

  const result = await page.evaluate(() => {
    return window.bnhpApp.restContext;
  });

  return result.slice(1);
}

async function fetchPoalimXSRFWithinPage(
  page: Page,
  url: string,
  pageUuid: string,
): Promise<FetchedAccountTransactionsData | null> {
  const cookies = await page.cookies();
  const XSRFCookie = cookies.find(cookie => cookie.name === 'XSRF-TOKEN');
  const headers: Record<string, any> = {};
  if (XSRFCookie != null) {
    headers['X-XSRF-TOKEN'] = XSRFCookie.value;
  }
  headers.pageUuid = pageUuid;
  headers.uuid = randomUUID();
  headers['Content-Type'] = 'application/json;charset=UTF-8';
  return fetchPostWithinPage<FetchedAccountTransactionsData>(page, url, [], headers);
}

async function getExtraScrap(
  txnsResult: FetchedAccountTransactionsData,
  baseUrl: string,
  page: Page,
  accountNumber: string,
): Promise<FetchedAccountTransactionsData> {
  const promises = txnsResult.transactions.map(async (transaction: ScrapedTransaction): Promise<ScrapedTransaction> => {
    const { pfmDetails, serialNumber } = transaction;
    if (serialNumber !== 0) {
      const url = `${baseUrl}${pfmDetails}&accountId=${accountNumber}&lang=he`;
      const extraTransactionDetails = (await fetchGetWithinPage<ScrapedPfmTransaction[]>(page, url)) || [];
      if (extraTransactionDetails && extraTransactionDetails.length) {
        const { transactionNumber } = extraTransactionDetails[0];
        if (transactionNumber) {
          return {
            ...transaction,
            referenceNumber: transactionNumber,
            additionalInformation: extraTransactionDetails,
          };
        }
      }
    }
    return transaction;
  });
  const res = await Promise.all(promises);
  return { transactions: res };
}

async function getAccountTransactions(
  baseUrl: string,
  apiSiteUrl: string,
  page: Page,
  accountNumber: string,
  startDate: string,
  endDate: string,
  additionalTransactionInformation = false,
  options?: ScraperOptions,
) {
  const txnsUrl = `${apiSiteUrl}/current-account/transactions?accountId=${accountNumber}&numItemsPerPage=1000&retrievalEndDate=${endDate}&retrievalStartDate=${startDate}&sortCode=1`;
  const txnsResult = await fetchPoalimXSRFWithinPage(page, txnsUrl, '/current-account/transactions');

  const finalResult =
    additionalTransactionInformation && txnsResult?.transactions.length
      ? await getExtraScrap(txnsResult, baseUrl, page, accountNumber)
      : txnsResult;

  return convertTransactions(finalResult?.transactions ?? [], options);
}

async function getAccountBalance(apiSiteUrl: string, page: Page, accountNumber: string) {
  const balanceAndCreditLimitUrl = `${apiSiteUrl}/current-account/composite/balanceAndCreditLimit?accountId=${accountNumber}&view=details&lang=he`;
  const balanceAndCreditLimit = await fetchGetWithinPage<BalanceAndCreditLimit>(page, balanceAndCreditLimitUrl);

  return balanceAndCreditLimit?.currentBalance;
}

async function fetchAccountData(page: Page, baseUrl: string, options: ScraperOptions) {
  const restContext = await getRestContext(page);
  const apiSiteUrl = `${baseUrl}/${restContext}`;
  const accountDataUrl = `${baseUrl}/ServerServices/general/accounts`;

  debug('fetching accounts data');
  const accountsInfo = (await fetchGetWithinPage<FetchedAccountData>(page, accountDataUrl)) || [];
  const openAccountsInfo = accountsInfo.filter(account => account.accountClosingReasonCode === 0);
  debug(
    'got %d open accounts from %d total accounts, fetching txns and balance',
    openAccountsInfo.length,
    accountsInfo.length,
  );

  const defaultStartMoment = moment().subtract(1, 'years').add(1, 'day');
  const startDate = options.startDate || defaultStartMoment.toDate();
  const startMoment = moment.max(defaultStartMoment, moment(startDate));
  const { additionalTransactionInformation } = options;

  const startDateStr = startMoment.format(DATE_FORMAT);
  const endDateStr = moment().format(DATE_FORMAT);

  const accounts: TransactionsAccount[] = [];

  for (const account of openAccountsInfo) {
    debug('getting information for account %s', account.accountNumber);
    const accountNumber = `${account.bankNumber}-${account.branchNumber}-${account.accountNumber}`;

    const balance = await getAccountBalance(apiSiteUrl, page, accountNumber);
    const txns = await getAccountTransactions(
      baseUrl,
      apiSiteUrl,
      page,
      accountNumber,
      startDateStr,
      endDateStr,
      additionalTransactionInformation,
      options,
    );

    accounts.push({
      accountNumber,
      balance,
      txns,
    });
  }

  const accountData = {
    success: true,
    accounts,
  };
  debug('fetching ended');
  return accountData;
}

// On an unrecognized device Bank Hapoalim shows an SMS one-time-code overlay after the
// credentials are submitted, WITHOUT any redirect. These selectors belong to that overlay.
const OTP_FORM_SELECTOR = 'form.auth-otp-login';
const OTP_SUBMIT_SELECTOR = '.btn-red_1';
const OTP_ERROR_SELECTOR = '.errors-rb .error-message, .auth-otp-login .error';

// The library's own Success conditions are exact URL matches; after the overlay closes,
// the homepage URL can carry extra query parameters, so only fragments are matched here.
const OTP_HOME_URL_FRAGMENTS = [
  '/portalserver/HomePage',
  '/ng-portals-bt/rb/he/homepage',
  '/ng-portals/rb/he/homepage',
];

const MAX_OTP_ATTEMPTS = 3;
const OTP_RESULT_TIMEOUT_MS = 20000;
const OTP_HOME_TIMEOUT_MS = 10000;
const OTP_POLL_INTERVAL_MS = 1000;
const LOGIN_SETTLE_TIMEOUT_MS = 20000;
const LOCAL_STORAGE_GOTO_TIMEOUT_MS = 15000;

// The browser rejects an expires value that is not a positive future timestamp, so a
// stored session cookie (expires: -1) or an already-expired one is restored as a session
// cookie by omitting the field. Only whitelisted fields are replayed.
function toCookieParam(cookie: CookieData): CookieData {
  const param: CookieData = {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: cookie.sameSite,
  };
  if (typeof cookie.expires === 'number' && cookie.expires > Date.now() / 1000) {
    param.expires = cookie.expires;
  }
  return param;
}

function getPossibleLoginResults(baseUrl: string) {
  const urls: PossibleLoginResults = {};
  urls[LoginResults.Success] = [
    `${baseUrl}/portalserver/HomePage`,
    `${baseUrl}/ng-portals-bt/rb/he/homepage`,
    `${baseUrl}/ng-portals/rb/he/homepage`,
  ];
  urls[LoginResults.InvalidPassword] = [
    `${baseUrl}/AUTHENTICATE/LOGON?flow=AUTHENTICATE&state=LOGON&errorcode=1.6&callme=false`,
  ];
  urls[LoginResults.ChangePassword] = [
    `${baseUrl}/MCP/START?flow=MCP&state=START&expiredDate=null`,
    /\/ABOUTTOEXPIRE\/START/i,
  ];
  // The SMS-code overlay appears on the login URL without a redirect, so it can only be
  // detected in the DOM. The condition must never throw: getKeyByValue in the base class
  // awaits it without any try/catch.
  urls[LoginResults.TwoFactorRetrieverMissing] = [
    async (options?: { page?: Page }) => {
      try {
        if (!options?.page) {
          return false;
        }
        return !!(await options.page.$(OTP_FORM_SELECTOR));
      } catch {
        return false;
      }
    },
  ];
  return urls;
}

function createLoginFields(credentials: ScraperSpecificCredentials) {
  return [
    { selector: '#userCode', value: credentials.userCode },
    { selector: '#password', value: credentials.password },
  ];
}

type OtpCodeRetriever = (options: { attempt: number }) => Promise<string>;

type ScraperSpecificCredentials = {
  userCode: string;
  password: string;
  otpCodeRetriever?: OtpCodeRetriever;
};

class HapoalimScraper extends BaseScraperWithBrowser<ScraperSpecificCredentials> {
  private deviceTrustData?: DeviceTrustData;

  get baseUrl() {
    return 'https://login.bankhapoalim.co.il';
  }

  getLoginOptions(credentials: ScraperSpecificCredentials) {
    return {
      loginUrl: `${this.baseUrl}/cgi-bin/poalwwwc?reqName=getLogonPage`,
      fields: createLoginFields(credentials),
      submitButtonSelector: '.login-btn',
      postAction: async () => {
        let initialUrl: string;
        try {
          initialUrl = await getCurrentUrl(this.page, true);
        } catch {
          initialUrl = this.page.url();
        }
        // The poll function must be total: waitUntil rejects when the test throws, and
        // the base class's next step after postAction is a page.evaluate of its own that
        // would turn a mid-navigation throw into a GENERIC login error. A throw here
        // (e.g. execution context destroyed) means a navigation is in flight, so keep
        // polling; stop only on a settled URL change or when the overlay is up.
        await waitUntil(
          async () => {
            try {
              const currentUrl = await getCurrentUrl(this.page, true);
              if (currentUrl !== initialUrl) {
                return true;
              }
              return await this.isOtpFormPresent();
            } catch {
              return false;
            }
          },
          'waiting for redirect or the SMS code form',
          LOGIN_SETTLE_TIMEOUT_MS,
          OTP_POLL_INTERVAL_MS,
        );
      },
      possibleResults: getPossibleLoginResults(this.baseUrl),
    };
  }

  async initialize() {
    await super.initialize();
    // Best effort only: BaseScraper.scrape() calls initialize() outside any try/catch,
    // so a throw here would crash the whole scrape instead of just losing the stored
    // device session.
    try {
      if (this.options.deviceTrustData) {
        await this.injectDeviceTrust(this.options.deviceTrustData);
      }
    } catch (e) {
      debug('failed to inject device trust data, continuing without it: %s', (e as Error).message);
    }
  }

  async login(credentials: ScraperSpecificCredentials): Promise<ScraperLoginResult> {
    let result: ScraperLoginResult;
    try {
      result = await super.login(credentials);
    } catch (e) {
      // The base class cannot map the TwoFactorRetrieverMissing key: its private
      // handleLoginResult throws on unknown results, and it must stay untouched. An
      // SMS-code challenge therefore arrives here as a thrown error. The DOM is the
      // source of truth: if the overlay is up, the bank challenged this device,
      // whatever the error says.
      if (!(await this.isOtpFormPresent())) {
        throw e;
      }
      debug('the bank asked for an SMS code after the credentials were submitted');
      result = { success: false, errorType: ScraperErrorTypes.TwoFactorRetrieverMissing };
    }

    if (result.success || result.errorType !== ScraperErrorTypes.TwoFactorRetrieverMissing) {
      return result;
    }

    if (typeof credentials.otpCodeRetriever !== 'function') {
      debug('an SMS code is required but no otpCodeRetriever credential was provided');
      this.emitProgress(ScraperProgressTypes.LoginFailed);
      return {
        success: false,
        errorType: ScraperErrorTypes.TwoFactorRetrieverMissing,
        errorMessage: 'Bank Hapoalim asked for an SMS code and no otpCodeRetriever was provided',
      };
    }

    return this.otpLogin(credentials.otpCodeRetriever);
  }

  private async otpLogin(otpCodeRetriever: OtpCodeRetriever): Promise<ScraperLoginResult> {
    for (let attempt = 1; attempt <= MAX_OTP_ATTEMPTS; attempt += 1) {
      debug('requesting an SMS code from the caller (attempt %d/%d)', attempt, MAX_OTP_ATTEMPTS);
      const code = await otpCodeRetriever({ attempt });
      // The bank's code is digits, possibly typed with spaces; normalize before filling.
      // An empty answer means the caller is giving up, not a wrong code.
      const digits = typeof code === 'string' ? code.replace(/\s+/g, '') : '';
      if (!digits) {
        debug('no SMS code was provided, aborting the OTP flow');
        this.emitProgress(ScraperProgressTypes.LoginFailed);
        return {
          success: false,
          errorType: ScraperErrorTypes.TwoFactorRetrieverMissing,
          errorMessage: 'Bank Hapoalim asked for an SMS code and none was provided',
        };
      }

      await this.fillOtpCode(digits);

      // page.click() sends trusted mouse events; the bank's Angular form ignores a
      // synthetic el.click().
      debug('submitting the SMS code');
      await this.page.click(OTP_SUBMIT_SELECTOR);

      const outcome = await this.waitForOtpOutcome();
      if (outcome === 'gone') {
        const reachedHomePage = await this.waitForHomePage();
        if (reachedHomePage) {
          debug('SMS code verification succeeded');
          this.emitProgress(ScraperProgressTypes.LoginSuccess);
          return { success: true };
        }
        // The code was accepted but the homepage never loaded; asking for another code
        // cannot help, so fail now without spending the remaining attempts.
        this.emitProgress(ScraperProgressTypes.LoginFailed);
        return {
          success: false,
          errorType: ScraperErrorTypes.General,
          errorMessage: 'Bank Hapoalim did not reach the homepage after accepting the SMS code',
        };
      }

      debug('the bank rejected the SMS code (attempt %d/%d)', attempt, MAX_OTP_ATTEMPTS);
    }

    this.emitProgress(ScraperProgressTypes.LoginFailed);
    return {
      success: false,
      errorType: ScraperErrorTypes.General,
      errorMessage: `SMS code verification failed after ${MAX_OTP_ATTEMPTS} attempts`,
    };
  }

  private async fillOtpCode(code: string) {
    const inputs = await this.page.$$(`${OTP_FORM_SELECTOR} input[type="text"]`);
    debug('filling the SMS code into %d digit inputs', inputs.length);
    for (let i = 0; i < inputs.length; i += 1) {
      const input = inputs[i];
      await input.click();
      await input.evaluate(el => {
        el.value = '';
      });
      if (i < code.length) {
        await input.type(code[i]);
      }
      await sleep(100);
    }
  }

  // Resolves 'gone' when the overlay closed (the code was accepted) and 'error' when the
  // bank shows an inline rejection. A wrong code leaves the overlay up with the URL
  // unchanged, so a waitForRedirect-style wait would simply time out; a timeout (or any
  // rejected poll) is treated as a rejection and retried with a fresh code.
  private async waitForOtpOutcome(): Promise<'gone' | 'error'> {
    try {
      return await waitUntil(
        async (): Promise<'gone' | 'error' | false> => {
          let form;
          try {
            form = await this.page.$(OTP_FORM_SELECTOR);
          } catch {
            // The execution context was destroyed: the page is navigating away from the
            // overlay, which after a submit only happens for an accepted code.
            return 'gone';
          }
          if (!form) {
            return 'gone';
          }
          try {
            return (await this.page.$(OTP_ERROR_SELECTOR)) ? 'error' : false;
          } catch {
            return false;
          }
        },
        'waiting for the SMS code result',
        OTP_RESULT_TIMEOUT_MS,
        OTP_POLL_INTERVAL_MS,
      );
    } catch {
      return 'error';
    }
  }

  private async waitForHomePage(): Promise<boolean> {
    try {
      // page.url() never throws, so this poll survives mid-navigation states. Wrapped in
      // Promise.resolve because the repo's eslint gate forbids an await-less async fn.
      await waitUntil(
        () => Promise.resolve(OTP_HOME_URL_FRAGMENTS.some(fragment => this.page.url().includes(fragment))),
        'waiting for the homepage after the SMS code was accepted',
        OTP_HOME_TIMEOUT_MS,
        OTP_POLL_INTERVAL_MS,
      );
      return true;
    } catch {
      return false;
    }
  }

  private async isOtpFormPresent(): Promise<boolean> {
    try {
      return !!(await this.page.$(OTP_FORM_SELECTOR));
    } catch {
      return false;
    }
  }

  async terminate(success: boolean) {
    // Extraction must run before the base cleanups close the page, and it must never
    // throw: a terminate() throw turns a successful scrape into GENERIC in
    // BaseScraper.scrape().
    if (success) {
      try {
        this.deviceTrustData = await this.extractDeviceTrust();
        debug(
          'extracted device trust data: %d cookies, %d localStorage entries',
          this.deviceTrustData.cookies.length,
          Object.keys(this.deviceTrustData.localStorage).length,
        );
      } catch (e) {
        debug('failed to extract device trust data: %s', (e as Error).message);
      }
    }
    await super.terminate(success);
  }

  async scrape(credentials: ScraperSpecificCredentials): Promise<ScraperScrapingResult> {
    this.deviceTrustData = undefined;
    const result = await super.scrape(credentials);
    if (result.success && this.deviceTrustData) {
      result.deviceTrustData = this.deviceTrustData;
    }
    return result;
  }

  private async injectDeviceTrust(data: DeviceTrustData) {
    debug('injecting device trust data');
    const cookies = Array.isArray(data.cookies) ? data.cookies : [];
    for (const cookie of cookies) {
      try {
        await this.page.setCookie(toCookieParam(cookie));
      } catch (e) {
        debug('failed to inject cookie %s: %s', cookie?.name, (e as Error).message);
      }
    }

    const storedLocalStorage = data.localStorage && typeof data.localStorage === 'object' ? data.localStorage : {};
    const entries = Object.entries(storedLocalStorage);
    if (!entries.length) {
      return;
    }

    // localStorage is origin-scoped: it must be restored on the origin it was captured
    // from, or the bank's login JS reads no device id and re-challenges. Extraction runs
    // on the post-login homepage, which is always on this scraper's base URL, so that is
    // the only origin the stored entries can legitimately belong to.
    try {
      await this.page.goto(this.baseUrl, { waitUntil: 'domcontentloaded', timeout: LOCAL_STORAGE_GOTO_TIMEOUT_MS });
      await this.page.evaluate((items: Record<string, string>) => {
        for (const [key, value] of Object.entries(items)) {
          window.localStorage.setItem(key, value);
        }
      }, storedLocalStorage);
      debug('restored %d localStorage entries at %s', entries.length, this.baseUrl);
    } catch (e) {
      debug('failed to restore localStorage: %s', (e as Error).message);
    }
  }

  private async extractDeviceTrust(): Promise<DeviceTrustData> {
    // page.cookies() returns only the current URL's cookies under puppeteer 24 (and is
    // deprecated); the device registration lives in cookies scoped to the whole login
    // domain, so read the browser context's full cookie store.
    const rawCookies = await this.page.browserContext().cookies();
    const cookies: CookieData[] = rawCookies.map(
      ({ name, value, domain, path, expires, httpOnly, secure, sameSite }) => ({
        name,
        value,
        domain,
        path,
        expires,
        httpOnly,
        secure,
        sameSite,
      }),
    );

    const localStorage = await this.page.evaluate(() => {
      const items: Record<string, string> = {};
      for (let i = 0; i < window.localStorage.length; i += 1) {
        const key = window.localStorage.key(i)!;
        items[key] = window.localStorage.getItem(key)!;
      }
      return items;
    });

    const origin = await this.page.evaluate(() => window.location.origin);

    return { cookies, localStorage, origin };
  }

  async fetchData() {
    return fetchAccountData(this.page, this.baseUrl, this.options);
  }
}

export default HapoalimScraper;
