/**
 * Environment variable loader with fail-fast validation.
 *
 * Every agent example starts by calling `loadEnv()` (via `DemoContext.load`)
 * so that a misconfigured machine produces a single, clear error instead of
 * surfacing as a mysterious 401 / 404 later in the request chain.
 */

export interface DemoEnv {
  /** Base URL of the Cobo Agentic Wallet service, e.g. `https://api.agenticwallet.cobo.com`. */
  basePath: string;
  /** Owner-scoped API key (used to submit pacts and read audit logs). */
  ownerKey: string;
  /** UUID of the wallet the demo operates on. */
  walletId: string;
  /** Address to transfer towards; defaults to a burn-style placeholder. */
  destination: string;
  /** Only required when actually invoking an LLM-backed agent. */
  openaiApiKey?: string;
}

const DEFAULT_DESTINATION = '0x1111111111111111111111111111111111111111';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. See README.md for the full list.`,
    );
  }
  return value;
}

export function loadEnv(): DemoEnv {
  return {
    basePath: requireEnv('AGENT_WALLET_API_URL'),
    ownerKey: requireEnv('AGENT_WALLET_API_KEY'),
    walletId: requireEnv('AGENT_WALLET_WALLET_ID'),
    destination: process.env.CAW_DESTINATION ?? DEFAULT_DESTINATION,
    openaiApiKey: process.env.OPENAI_API_KEY,
  };
}
