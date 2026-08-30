// oauth/refresh.ts — refresh OAuth tokens before inference

import { refreshGitHubCopilotToken } from './github-copilot.js';
import { refreshOpenAiAccessToken } from './openai.js';
import { GITHUB_COPILOT_PROVIDER_ID } from '../github-copilot.js';
import type { StoredOAuthCredential } from './types.js';
import { accessTokenIsExpiring, NATIVE_OAUTH_PROVIDER_IDS, oauthCredentialNeedsRefresh, tokensToStoredCredential } from './types.js';

export function oauthCredentialShouldRefresh(
  cred: Pick<StoredOAuthCredential, 'access' | 'expires'>,
  providerId: string,
): boolean {
  if (oauthCredentialNeedsRefresh(cred)) return true;
  // All native OAuth providers use short-lived access tokens — check expiry proactively
  if ((NATIVE_OAUTH_PROVIDER_IDS as readonly string[]).includes(providerId) && accessTokenIsExpiring(cred.access)) return true;
  return false;
}

export async function refreshStoredOAuthCredential(
  providerId: string,
  cred: StoredOAuthCredential,
): Promise<StoredOAuthCredential> {
  if (!cred.refresh) {
    throw new Error(`${providerId}: OAuth refresh token missing — run clodex providers auth ${providerId}`);
  }

  let tokens;
  if (providerId === 'openai' || providerId === 'openai-oauth') {
    tokens = await refreshOpenAiAccessToken(cred.refresh);
  } else if (providerId === GITHUB_COPILOT_PROVIDER_ID) {
    // `refresh` holds the long-lived GitHub OAuth token, which mints a new
    // Copilot API token without any user interaction.
    tokens = await refreshGitHubCopilotToken(cred.refresh);
  } else {
    throw new Error(`OAuth refresh not implemented for provider "${providerId}"`);
  }

  return tokensToStoredCredential(tokens, cred.refresh, cred.accountId, cred.providerData);
}
