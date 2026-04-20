/**
 * Single source of truth for the demo pact specification.
 *
 * Every agent example submits the same transfer policy: allow transfers on
 * `(CHAIN_ID, TOKEN_ID)` while denying any transfer whose amount exceeds
 * `DENY_THRESHOLD`. Editing this file affects all examples uniformly.
 */

import type { PactSpecInput } from '@cobo/agentic-wallet';

export const CHAIN_ID = 'SETH';
export const TOKEN_ID = 'SETH';

/** Compliant transfer amount — passes the policy cap. */
export const ALLOWED_AMOUNT = '0.001';
/** Non-compliant amount — exceeds the policy cap and should be denied. */
export const DENIED_AMOUNT = '0.005';
/** Policy cap: transfers strictly greater than this will be denied. */
export const DENY_THRESHOLD = '0.002';
/** Pact auto-finalizes after this elapsed time (in seconds). */
export const PACT_TTL_SECONDS = '86400';

export interface BuildPactSpecOptions {
  chainId?: string;
  tokenId?: string;
  denyThreshold?: string;
  ttlSeconds?: string;
}

/**
 * Builds a reusable `PactSpecInput` payload that allows transfers on
 * `(chainId, tokenId)` but denies any transfer whose amount exceeds
 * `denyThreshold`.
 */
export function buildTransferPactSpec(opts: BuildPactSpecOptions = {}): PactSpecInput {
  const chainId = opts.chainId ?? CHAIN_ID;
  const tokenId = opts.tokenId ?? TOKEN_ID;
  const denyThreshold = opts.denyThreshold ?? DENY_THRESHOLD;
  const ttl = opts.ttlSeconds ?? PACT_TTL_SECONDS;

  return {
    policies: [
      {
        name: 'max-tx-limit',
        type: 'transfer',
        rules: {
          effect: 'allow',
          when: {
            chain_in: [chainId],
            token_in: [{ chain_id: chainId, token_id: tokenId }],
          },
          deny_if: { amount_gt: denyThreshold },
        },
      },
    ],
    completion_conditions: [{ type: 'time_elapsed', threshold: ttl }],
  };
}
