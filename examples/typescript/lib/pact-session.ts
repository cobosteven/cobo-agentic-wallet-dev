/**
 * Tracks the `pact_id → pact-scoped api_key` mapping across an agent session
 * and lazily materialises per-pact `TransactionsApi` clients.
 *
 * Agent tools register pacts as they are submitted or fetched (by calling
 * `capture` on the response payload), then look up the appropriate scoped
 * client by `pact_id` at call time via `txApiFor`.
 */

import type { TransactionsApi } from '@cobo/agentic-wallet';

import { buildPactScopedTxApi } from './clients';

export class PactSessionStore {
  private readonly sessions = new Map<string, string>();
  private readonly txApiCache = new Map<string, TransactionsApi>();

  constructor(
    private readonly ownerTxApi: TransactionsApi,
    private readonly basePath: string,
  ) {}

  /**
   * Extracts `(pact_id, api_key)` from a pact response envelope and records
   * the mapping. Handles both `submit_pact` and `get_pact` response shapes.
   */
  capture(response: unknown): void {
    if (!response || typeof response !== 'object') return;
    const r = response as Record<string, unknown>;
    const pactId = (r.pact_id ?? r.id) as string | undefined;
    const apiKey = r.api_key as string | undefined;
    if (typeof pactId === 'string' && typeof apiKey === 'string' && apiKey) {
      this.sessions.set(pactId, apiKey);
    }
  }

  /** Whether the scoped api_key for `pactId` has already been captured. */
  has(pactId: string): boolean {
    return this.sessions.has(pactId);
  }

  /**
   * Returns the `TransactionsApi` client appropriate for the given pact id.
   * Falls back to the owner-scoped client when `pactId` is omitted, and
   * throws a self-explanatory error if the pact was not captured yet.
   */
  txApiFor(pactId?: string): TransactionsApi {
    if (!pactId) return this.ownerTxApi;

    const cached = this.txApiCache.get(pactId);
    if (cached) return cached;

    const apiKey = this.sessions.get(pactId);
    if (!apiKey) {
      throw new Error(
        `Unknown pact_id ${pactId}. Call submit_pact or get_pact first ` +
          `so the pact-scoped api_key is captured, then retry.`,
      );
    }

    const scoped = buildPactScopedTxApi(apiKey, this.basePath);
    this.txApiCache.set(pactId, scoped);
    return scoped;
  }
}
