// oauth/github-copilot.ts — GitHub device-code sign-in and Copilot token exchange.
//
// Copilot sign-in is two steps with two very different lifetimes, and the
// stored credential deliberately mixes them:
//
//   refresh = the GitHub OAuth token. Long-lived, and the only thing a user
//             would have to repeat sign-in to replace.
//   access  = the Copilot API token. Expires in ~30 minutes and is minted from
//             the GitHub token, so it fits the `refresh` slot's contract
//             exactly: something the shared refresher can trade for a new
//             access token without any user interaction.
//
// That mapping is why no Copilot-specific refresh scheduling exists here — the
// registry's own expiry check (`oauthCredentialShouldRefresh`) already renews
// an access token before every request that needs one.

import {
  GITHUB_API_BASE_URL,
  GITHUB_BASE_URL,
  GITHUB_COPILOT_API_BASE_URL,
  GITHUB_COPILOT_CLIENT_ID,
  GITHUB_COPILOT_SCOPES,
  githubApiHeaders,
} from '../github-copilot.js';
import { positiveSecondsToMs, sleepMs } from './pkce.js';
import type { OAuthTokenResponse } from './types.js';

const DEVICE_CODE_DEFAULT_EXPIRES_MS = 15 * 60 * 1000;
const DEVICE_CODE_DEFAULT_INTERVAL_S = 5;
/** GitHub's documented back-off increment when it answers `slow_down`. */
const SLOW_DOWN_INCREMENT_MS = 5_000;
const GITHUB_REQUEST_TIMEOUT_MS = 30_000;

export interface GitHubDeviceCodeData {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in?: number;
  interval?: number;
}

export interface CopilotTokenResponse {
  token: string;
  /** Epoch SECONDS at which the Copilot token stops working. */
  expires_at?: number;
  refresh_in?: number;
  endpoints?: { api?: string };
}

interface GitHubDeviceTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

async function fetchJson<T>(url: string, init: RequestInit, errorPrefix: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
    GITHUB_REQUEST_TIMEOUT_MS,
  );
  timer.unref();
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 200).trim();
      throw new Error(`${errorPrefix} (${response.status})${detail ? `: ${detail}` : ''}`);
    }
    return await response.json() as T;
  } finally {
    clearTimeout(timer);
  }
}

export async function requestGitHubDeviceCode(): Promise<GitHubDeviceCodeData> {
  const data = await fetchJson<GitHubDeviceCodeData>(
    `${GITHUB_BASE_URL}/login/device/code`,
    {
      method: 'POST',
      // Without `Accept: application/json` GitHub answers these two endpoints
      // with a form-encoded body, which JSON parsing would reject.
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: GITHUB_COPILOT_CLIENT_ID, scope: GITHUB_COPILOT_SCOPES }),
    },
    'Failed to start GitHub device authorization',
  );
  if (!data?.device_code || !data.user_code) {
    throw new Error('GitHub device authorization returned an incomplete response');
  }
  return data;
}

export function githubDeviceCodeUrl(deviceData: GitHubDeviceCodeData): string {
  return deviceData.verification_uri?.trim() || `${GITHUB_BASE_URL}/login/device`;
}

/**
 * Poll GitHub for the device-flow access token.
 *
 * GitHub reports pending and terminal states as HTTP **200 with an `error`
 * field**, not as a status code — so status-code-driven polling (the shape the
 * OpenAI flow in this directory uses) would treat a denied or expired
 * authorization as success-adjacent and keep polling until the deadline. Each
 * documented terminal error therefore aborts with its own message.
 */
export async function pollGitHubDeviceCodeToken(
  deviceData: GitHubDeviceCodeData,
  opts?: { sleep?: (ms: number) => Promise<void>; now?: () => number },
): Promise<string> {
  const sleep = opts?.sleep ?? sleepMs;
  const now = opts?.now ?? (() => Date.now());
  let intervalMs = positiveSecondsToMs(deviceData.interval, DEVICE_CODE_DEFAULT_INTERVAL_S * 1000);
  const deadline = now() + positiveSecondsToMs(deviceData.expires_in, DEVICE_CODE_DEFAULT_EXPIRES_MS);

  while (now() < deadline) {
    await sleep(Math.min(intervalMs, Math.max(0, deadline - now())));

    const data = await fetchJson<GitHubDeviceTokenResponse>(
      `${GITHUB_BASE_URL}/login/oauth/access_token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          client_id: GITHUB_COPILOT_CLIENT_ID,
          device_code: deviceData.device_code,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      },
      'GitHub device authorization failed',
    );

    const token = data.access_token?.trim();
    if (token) return token;

    switch (data.error) {
      case 'authorization_pending':
        break;
      case 'slow_down':
        intervalMs += SLOW_DOWN_INCREMENT_MS;
        break;
      case 'expired_token':
        throw new Error('GitHub device authorization expired before it was approved — run the sign-in again');
      case 'access_denied':
        throw new Error('GitHub device authorization was denied');
      default:
        throw new Error(
          `GitHub device authorization failed: ${data.error_description ?? data.error ?? 'unknown error'}`,
        );
    }
  }
  throw new Error('GitHub device authorization timed out');
}

/**
 * Trade the GitHub OAuth token for a short-lived Copilot API token.
 *
 * Also the entitlement check: an account without a Copilot subscription gets a
 * 403 here, which is the earliest and clearest place to find that out.
 */
export async function fetchCopilotToken(githubToken: string): Promise<CopilotTokenResponse> {
  const data = await fetchJson<CopilotTokenResponse>(
    `${GITHUB_API_BASE_URL}/copilot_internal/v2/token`,
    { method: 'GET', headers: githubApiHeaders(githubToken) },
    'GitHub rejected the Copilot token request',
  );
  if (!data?.token?.trim()) {
    throw new Error(
      'GitHub did not return a Copilot token — check that this account has an active Copilot subscription',
    );
  }
  return data;
}

/** The GitHub login for this token, for the sign-in confirmation. Best effort. */
export async function fetchGitHubLogin(githubToken: string): Promise<string | undefined> {
  try {
    const user = await fetchJson<{ login?: string }>(
      `${GITHUB_API_BASE_URL}/user`,
      { method: 'GET', headers: githubApiHeaders(githubToken) },
      'Could not read the GitHub account',
    );
    return typeof user.login === 'string' && user.login.trim() ? user.login.trim() : undefined;
  } catch {
    // Purely cosmetic — never fail a working sign-in over the display name.
    return undefined;
  }
}

/**
 * Present a Copilot token as the OAuth token response the shared credential
 * store understands. `expires_at` is absolute epoch seconds while
 * `tokensToStoredCredential` wants a relative lifetime, so convert here rather
 * than teaching the shared code a second expiry convention.
 */
export function copilotTokenToOAuthResponse(
  copilot: CopilotTokenResponse,
  githubToken: string,
  now: number = Date.now(),
): OAuthTokenResponse {
  const remainingMs = typeof copilot.expires_at === 'number' && Number.isFinite(copilot.expires_at)
    ? copilot.expires_at * 1000 - now
    : undefined;
  // A token that already looks expired is still worth storing as expired: the
  // next request refreshes it instead of failing on a negative lifetime.
  const refreshIn = typeof copilot.refresh_in === 'number' && copilot.refresh_in > 0
    ? Math.floor(copilot.refresh_in)
    : 0;
  const expiresIn = remainingMs !== undefined && remainingMs > 0
    ? Math.floor(remainingMs / 1000)
    : refreshIn;
  return {
    access_token: copilot.token,
    refresh_token: githubToken,
    expires_in: expiresIn,
  };
}

/** The API host this account must use — business and enterprise plans get their own. */
export function copilotApiBaseUrl(copilot: CopilotTokenResponse): string {
  const endpoint = copilot.endpoints?.api?.trim();
  if (!endpoint) return GITHUB_COPILOT_API_BASE_URL;
  try {
    const url = new URL(endpoint);
    // Only https, and only somewhere under githubcopilot.com: this value comes
    // off the wire and becomes the address a live credential is sent to.
    if (url.protocol !== 'https:') return GITHUB_COPILOT_API_BASE_URL;
    if (url.hostname !== 'githubcopilot.com' && !url.hostname.endsWith('.githubcopilot.com')) {
      return GITHUB_COPILOT_API_BASE_URL;
    }
    return endpoint.replace(/\/$/, '');
  } catch {
    return GITHUB_COPILOT_API_BASE_URL;
  }
}

export interface GitHubCopilotSignIn {
  tokens: OAuthTokenResponse;
  /** GitHub login, for the sign-in confirmation message. */
  accountId?: string;
  /** Copilot API host for this account; written to the provider record. */
  apiUrl: string;
}

export async function runGitHubCopilotDeviceCodeFlow(
  onDeviceCode: (info: { url: string; userCode: string }) => void,
  opts?: { sleep?: (ms: number) => Promise<void>; now?: () => number },
): Promise<GitHubCopilotSignIn> {
  const deviceData = await requestGitHubDeviceCode();
  onDeviceCode({ url: githubDeviceCodeUrl(deviceData), userCode: deviceData.user_code });
  const githubToken = await pollGitHubDeviceCodeToken(deviceData, opts);
  const copilot = await fetchCopilotToken(githubToken);
  return {
    tokens: copilotTokenToOAuthResponse(copilot, githubToken, opts?.now?.() ?? Date.now()),
    accountId: await fetchGitHubLogin(githubToken),
    apiUrl: copilotApiBaseUrl(copilot),
  };
}

/** Mint a fresh Copilot token from the stored GitHub token. */
export async function refreshGitHubCopilotToken(githubToken: string): Promise<OAuthTokenResponse> {
  const copilot = await fetchCopilotToken(githubToken);
  return copilotTokenToOAuthResponse(copilot, githubToken);
}
