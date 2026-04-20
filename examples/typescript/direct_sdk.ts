/**
 * Canonical TypeScript SDK example for the current CAW onboarding model.
 *
 * No agent framework is involved — the code calls the SDK directly so readers
 * can see the pact lifecycle in its simplest form. Only a minimal subset of
 * `./lib` is reused (env parsing, the shared pact spec, and API-error parsing)
 * so that the six-step tutorial flow stays entirely local to this file.
 *
 * Flow:
 *   1. submit a pact with an inline transfer policy
 *   2. wait until the pact is active (owner approval in the Cobo Agentic Wallet app)
 *   3. execute one compliant transfer using the pact-scoped API key
 *   4. trigger one denial (amount exceeds the policy cap) and log the structured error
 *   5. retry with a compliant amount
 *   6. inspect recent audit log entries for allowed / denied results
 */

import {
  AuditApi,
  Configuration,
  PactsApi,
  TransactionsApi,
} from '@cobo/agentic-wallet';

import { loadEnv } from './lib/env';
import {
  ALLOWED_AMOUNT,
  CHAIN_ID,
  DENIED_AMOUNT,
  DENY_THRESHOLD,
  TOKEN_ID,
  buildTransferPactSpec,
} from './lib/pact-spec';
import { parseApiError } from './lib/errors';

const POLL_INTERVAL_MS = 5_000;
const TERMINAL_STATUSES = new Set(['rejected', 'expired', 'revoked', 'completed']);

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function waitForPactActivation(
  pactsApi: PactsApi,
  pactId: string,
): Promise<string> {
  const started = Date.now();
  let lastStatus: string | undefined;

  for (;;) {
    const pact = (await pactsApi.getPact(pactId)).data.result;
    const status = pact.status ?? '';
    if (status !== lastStatus) {
      const elapsed = Math.floor((Date.now() - started) / 1000);
      console.log(`      pact status -> ${status} (elapsed ${elapsed}s)`);
      lastStatus = status;
    }
    if (status === 'active' && pact.api_key) return pact.api_key;
    if (TERMINAL_STATUSES.has(status)) {
      throw new Error(`Pact reached terminal status before use: ${status}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

async function main(): Promise<void> {
  const env = loadEnv();

  const ownerConfig = new Configuration({ apiKey: env.ownerKey, basePath: env.basePath });
  const pactsApi = new PactsApi(ownerConfig);
  const auditApi = new AuditApi(ownerConfig);

  // Step 1: submit the pact.
  console.log(
    `[1/6] Submitting pact (allow ${CHAIN_ID}/${TOKEN_ID} transfers, ` +
      `deny if amount > ${DENY_THRESHOLD})...`,
  );
  const pactResp = await pactsApi.submitPact({
    wallet_id: env.walletId,
    intent: 'Transfer tokens for integration testing',
    spec: buildTransferPactSpec(),
  });
  const pactId = pactResp.data.result.pact_id;
  console.log(`      pact submitted: id=${pactId}`);

  // Step 2: poll until active.
  console.log('[2/6] Waiting for owner approval in the Cobo Agentic Wallet app...');
  const pactApiKey = await waitForPactActivation(pactsApi, pactId);

  // Step 3: use the pact-scoped key.
  console.log('[3/6] Pact is active; switching to pact-scoped API key.');
  const pactConfig = new Configuration({ apiKey: pactApiKey, basePath: env.basePath });
  const txApi = new TransactionsApi(pactConfig);

  // Step 4: compliant transfer.
  console.log(
    `[4/6] Submitting allowed transfer: ${ALLOWED_AMOUNT} ${TOKEN_ID} -> ${env.destination}`,
  );
  const allowed = (
    await txApi.transferTokens(env.walletId, {
      chain_id: CHAIN_ID,
      dst_addr: env.destination,
      token_id: TOKEN_ID,
      amount: ALLOWED_AMOUNT,
    })
  ).data.result;
  console.log(
    `      ALLOWED: tx_id=${allowed.id} status=${allowed.status} (${allowed.status_display ?? '-'}) ` +
      `request_id=${allowed.request_id} hash=${allowed.transaction_hash ?? '-'}`,
  );

  // Step 5: trigger a denial, then retry inside the policy cap.
  console.log(
    `[5/6] Submitting transfer that should be blocked: ` +
      `${DENIED_AMOUNT} ${TOKEN_ID} -> ${env.destination}`,
  );
  try {
    await txApi.transferTokens(env.walletId, {
      chain_id: CHAIN_ID,
      dst_addr: env.destination,
      token_id: TOKEN_ID,
      amount: DENIED_AMOUNT,
    });
  } catch (error) {
    const { http, error: errBody, suggestion } = parseApiError(error);
    console.log(
      `      DENIED as expected: http=${http} ` +
        `code=${errBody?.code ?? '-'} reason=${errBody?.reason ?? '-'}`,
    );
    if (errBody?.details) console.log(`      details: ${JSON.stringify(errBody.details)}`);
    if (suggestion) console.log(`      suggestion: ${suggestion}`);

    console.log(`      retrying with compliant amount ${ALLOWED_AMOUNT} ${TOKEN_ID}...`);
    const retry = (
      await txApi.transferTokens(env.walletId, {
        chain_id: CHAIN_ID,
        dst_addr: env.destination,
        token_id: TOKEN_ID,
        amount: ALLOWED_AMOUNT,
      })
    ).data.result;
    console.log(
      `      RETRY ALLOWED: tx_id=${retry.id} status=${retry.status} (${retry.status_display ?? '-'}) ` +
        `request_id=${retry.request_id} hash=${retry.transaction_hash ?? '-'}`,
    );
  }

  // Step 6: audit-log summary.
  console.log('[6/6] Fetching recent audit entries for this wallet...');
  const logs = await auditApi.listAuditLogs(
    env.walletId,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    20,
  );
  const items = (logs.data.result as { items?: Array<{ result?: string }> })?.items ?? [];
  const allowedCount = items.filter(item => item.result === 'allowed').length;
  const deniedCount = items.filter(item => item.result === 'denied').length;
  console.log(
    `      audit (last ${items.length} entries): allowed=${allowedCount}, denied=${deniedCount}`,
  );
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
