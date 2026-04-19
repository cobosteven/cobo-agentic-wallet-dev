/**
 * Canonical TypeScript SDK example for the current CAW onboarding model.
 *
 * Flow:
 * 1. submit a pact with an inline transfer policy
 * 2. wait until the pact is active (owner approval in the Cobo Agentic Wallet app)
 * 3. execute one compliant transfer using the pact-scoped API key
 * 4. trigger one denial (amount exceeds the policy cap) and log the structured error
 * 5. inspect recent audit log entries for allowed/denied results
 */

import {
  AuditApi,
  Configuration,
  PactsApi,
  TransactionsApi,
} from '@cobo/agentic-wallet';

const CHAIN_ID = 'SETH';
const TOKEN_ID = 'SETH';
const ALLOWED_AMOUNT = '0.001';
const DENIED_AMOUNT = '0.005';
const DENY_THRESHOLD = '0.002';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

interface ApiErrorPayload {
  error?: { code?: string; reason?: string; details?: Record<string, string> };
  suggestion?: string;
}

function parseApiError(err: unknown): { http: number | string; payload: ApiErrorPayload } {
  const response = (err as { response?: { status?: number; data?: unknown } }).response;
  const http = response?.status ?? '-';
  const data = response?.data;
  const payload: ApiErrorPayload =
    data && typeof data === 'object' ? (data as ApiErrorPayload) : {};
  return { http, payload };
}

async function main(): Promise<void> {
  const basePath = process.env.AGENT_WALLET_API_URL!;
  const apiKey = process.env.AGENT_WALLET_API_KEY!;
  const walletId = process.env.AGENT_WALLET_WALLET_ID!;
  const destination =
    process.env.CAW_DESTINATION ?? '0x1111111111111111111111111111111111111111';

  const ownerConfig = new Configuration({ apiKey, basePath });
  const pactsApi = new PactsApi(ownerConfig);
  const auditApi = new AuditApi(ownerConfig);

  // Step 1: Submit a pact requesting transfer permissions for 24 hours.
  console.log(
    `[1/6] Submitting pact (allow ${CHAIN_ID}/${TOKEN_ID} transfers, ` +
      `deny if amount > ${DENY_THRESHOLD})...`,
  );
  const pactResp = await pactsApi.submitPact({
    wallet_id: walletId,
    intent: 'Transfer tokens for integration testing',
    spec: {
      policies: [
        {
          name: 'max-tx-limit',
          type: 'transfer',
          rules: {
            effect: 'allow',
            when: {
              chain_in: [CHAIN_ID],
              token_in: [{ chain_id: CHAIN_ID, token_id: TOKEN_ID }],
            },
            deny_if: { amount_gt: DENY_THRESHOLD },
          },
        },
      ],
      completion_conditions: [{ type: 'time_elapsed', threshold: '86400' }],
    },
  });
  const pactId = pactResp.data.result.pact_id;
  console.log(`      pact submitted: id=${pactId}`);

  // Step 2: Poll until the owner approves the pact.
  console.log('[2/6] Waiting for owner approval in the Cobo Agentic Wallet app...');
  const started = Date.now();
  let pactApiKey: string | undefined;
  let lastStatus: string | undefined;
  while (!pactApiKey) {
    const pact = (await pactsApi.getPact(pactId)).data.result;
    const status = pact.status ?? '';
    if (status !== lastStatus) {
      const elapsed = Math.floor((Date.now() - started) / 1000);
      console.log(`      pact status -> ${status} (elapsed ${elapsed}s)`);
      lastStatus = status;
    }
    if (status === 'active') {
      pactApiKey = pact.api_key;
      break;
    }
    if (['rejected', 'expired', 'revoked', 'completed'].includes(status)) {
      throw new Error(`Pact reached terminal status before use: ${status}`);
    }
    await sleep(5000);
  }

  // Step 3: Use the pact-scoped API key for all subsequent calls.
  console.log('[3/6] Pact is active; switching to pact-scoped API key.');
  const pactConfig = new Configuration({ apiKey: pactApiKey, basePath });
  const txApi = new TransactionsApi(pactConfig);

  // Step 4: Execute an allowed transfer (within the deny threshold).
  console.log(
    `[4/6] Submitting allowed transfer: ${ALLOWED_AMOUNT} ${TOKEN_ID} -> ${destination}`,
  );
  const allowed = (
    await txApi.transferTokens(walletId, {
      chain_id: CHAIN_ID,
      dst_addr: destination,
      token_id: TOKEN_ID,
      amount: ALLOWED_AMOUNT,
    })
  ).data.result;
  console.log(
    `      ALLOWED: tx_id=${allowed.id} status=${allowed.status} (${allowed.status_display ?? '-'}) ` +
      `request_id=${allowed.request_id} hash=${allowed.transaction_hash ?? '-'}`,
  );

  // Step 5: Trigger a policy denial (amount exceeds the deny threshold),
  // then follow the denial guidance and retry with a compliant amount.
  console.log(
    `[5/6] Submitting transfer that should be blocked: ` +
      `${DENIED_AMOUNT} ${TOKEN_ID} -> ${destination}`,
  );
  try {
    await txApi.transferTokens(walletId, {
      chain_id: CHAIN_ID,
      dst_addr: destination,
      token_id: TOKEN_ID,
      amount: DENIED_AMOUNT,
    });
  } catch (error) {
    const { http, payload } = parseApiError(error);
    const err = payload.error ?? {};
    console.log(
      `      DENIED as expected: http=${http} ` +
        `code=${err.code ?? '-'} reason=${err.reason ?? '-'}`,
    );
    if (err.details) {
      console.log(`      details: ${JSON.stringify(err.details)}`);
    }
    if (payload.suggestion) {
      console.log(`      suggestion: ${payload.suggestion}`);
    }

    console.log(
      `      retrying with compliant amount ${ALLOWED_AMOUNT} ${TOKEN_ID}...`,
    );
    const retry = (
      await txApi.transferTokens(walletId, {
        chain_id: CHAIN_ID,
        dst_addr: destination,
        token_id: TOKEN_ID,
        amount: ALLOWED_AMOUNT,
      })
    ).data.result;
    console.log(
      `      RETRY ALLOWED: tx_id=${retry.id} status=${retry.status} (${retry.status_display ?? '-'}) ` +
        `request_id=${retry.request_id} hash=${retry.transaction_hash ?? '-'}`,
    );
  }

  // Step 6: Verify allowed and denied events in audit logs.
  console.log('[6/6] Fetching recent audit entries for this wallet...');
  const logs = await auditApi.listAuditLogs(
    walletId,
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
