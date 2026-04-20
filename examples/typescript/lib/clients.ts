/**
 * Factories for the `@cobo/agentic-wallet` API clients.
 *
 * Two flavours exist in the pact-first usage model:
 *   - **owner-scoped** clients, authenticated with the operator's API key, used
 *     to submit pacts and read audit logs.
 *   - **pact-scoped** transactions clients, authenticated with the short-lived
 *     API key returned when a pact becomes active, used to actually move funds.
 */

import {
  AuditApi,
  Configuration,
  PactsApi,
  TransactionRecordsApi,
  TransactionsApi,
} from '@cobo/agentic-wallet';

import type { DemoEnv } from './env';

export interface OwnerApis {
  pactsApi: PactsApi;
  txApi: TransactionsApi;
  recordsApi: TransactionRecordsApi;
  auditApi: AuditApi;
}

/** Builds the owner-scoped API clients from a `DemoEnv`. */
export function buildOwnerApis(env: DemoEnv): OwnerApis {
  const config = new Configuration({ apiKey: env.ownerKey, basePath: env.basePath });
  return {
    pactsApi: new PactsApi(config),
    txApi: new TransactionsApi(config),
    recordsApi: new TransactionRecordsApi(config),
    auditApi: new AuditApi(config),
  };
}

/** Builds a `TransactionsApi` bound to a pact-scoped API key. */
export function buildPactScopedTxApi(apiKey: string, basePath: string): TransactionsApi {
  return new TransactionsApi(new Configuration({ apiKey, basePath }));
}

/**
 * Named-parameter wrapper around `AuditApi.listAuditLogs`, which would
 * otherwise require eight positional `undefined`s before `limit`.
 */
export async function listRecentAuditLogs(
  auditApi: AuditApi,
  walletId: string,
  limit = 20,
): Promise<{ items: Array<{ result?: string }>; allowed: number; denied: number }> {
  const response = await auditApi.listAuditLogs(
    walletId,
    undefined, // principal_id
    undefined, // action
    undefined, // result
    undefined, // start_time
    undefined, // end_time
    undefined, // after
    undefined, // before
    undefined, // cursor
    limit,
  );
  const items =
    (response.data.result as { items?: Array<{ result?: string }> })?.items ?? [];
  const allowed = items.filter(it => it.result === 'allowed').length;
  const denied = items.filter(it => it.result === 'denied').length;
  return { items, allowed, denied };
}
