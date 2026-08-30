import type { LocalProvider } from './types.js';

const OAUTH_FAVORITE_NAMES: Record<string, string> = {
  'openai-oauth': 'OpenAI OAuth (ChatGPT)',
  // Already names its auth; the generic " OAuth" suffix below would read as
  // "GitHub Copilot OAuth", which is not what anyone calls it.
  'github-copilot': 'GitHub Copilot',
};

export function favoriteProviderDisplayName(
  provider: Pick<LocalProvider, 'id' | 'name' | 'authType'>,
): string {
  const explicit = OAUTH_FAVORITE_NAMES[provider.id];
  if (explicit) return explicit;
  if (provider.authType === 'oauth' && !/\boauth\b/i.test(provider.name)) {
    return `${provider.name} OAuth`;
  }
  return provider.name;
}
