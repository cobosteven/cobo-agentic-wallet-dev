/**
 * OpenAI Agents SDK example using the current pact-first CAW usage model.
 */

import { Agent, run, tool } from '@openai/agents';
import { z } from 'zod';
import {
  AuditApi,
  Configuration,
  PactsApi,
  TransactionRecordsApi,
  TransactionsApi,
} from '@cobo/agentic-wallet';

const CHAIN_ID = 'SETH';
const TOKEN_ID = 'SETH';

const basePath = process.env.AGENT_WALLET_API_URL!;
const ownerKey = process.env.AGENT_WALLET_API_KEY!;
const ownerConfig = new Configuration({ apiKey: ownerKey, basePath });

const pactsApi = new PactsApi(ownerConfig);
const txApi = new TransactionsApi(ownerConfig);
const recordsApi = new TransactionRecordsApi(ownerConfig);
const auditApi = new AuditApi(ownerConfig);

// pact_id -> pact-scoped api_key, populated by submit_pact / get_pact tool calls
const pactSessions = new Map<string, string>();
// pact_id -> lazily-built TransactionsApi using the scoped api_key
const pactTxApiCache = new Map<string, TransactionsApi>();

function capturePactSession(response: unknown): void {
  if (!response || typeof response !== 'object') return;
  const r = response as Record<string, unknown>;
  const pactId = (r.pact_id ?? r.id) as string | undefined;
  const apiKey = r.api_key as string | undefined;
  if (typeof pactId === 'string' && typeof apiKey === 'string' && apiKey) {
    pactSessions.set(pactId, apiKey);
  }
}

function txApiFor(pactId?: string): TransactionsApi {
  if (!pactId) return txApi;
  const cached = pactTxApiCache.get(pactId);
  if (cached) return cached;
  const apiKey = pactSessions.get(pactId);
  if (!apiKey) {
    throw new Error(
      `Unknown pact_id ${pactId}. Call submit_pact or get_pact first so the pact-scoped api_key can be cached, then retry.`,
    );
  }
  const scoped = new TransactionsApi(new Configuration({ apiKey, basePath }));
  pactTxApiCache.set(pactId, scoped);
  return scoped;
}

async function returnPolicyDenial<T>(work: () => Promise<T>): Promise<T | Record<string, unknown>> {
  try {
    return await work();
  } catch (error) {
    const response = (error as { response?: { data?: { error?: Record<string, unknown>; suggestion?: string } } })
      .response;
    const data = response?.data;
    if (data?.error) {
      return { error: data.error, suggestion: data.suggestion };
    }
    return { error: 'UNKNOWN_ERROR' };
  }
}

const submitPact = tool({
  name: 'submit_pact',
  description: 'Submit a pact and return the pact id.',
  parameters: z.object({
    wallet_id: z.string(),
    intent: z.string(),
  }),
  async execute({ wallet_id, intent }) {
    const response = await pactsApi.submitPact({
      wallet_id,
      intent,
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
              deny_if: { amount_gt: '0.002' },
            },
          },
        ],
        completion_conditions: [{ type: 'time_elapsed', threshold: '86400' }],
      },
    });
    const result = response.data.result;
    capturePactSession(result);
    // Auto-activated pacts may carry status=active without api_key — fetch it now
    if (result && typeof result === 'object') {
      const r = result as unknown as Record<string, unknown>;
      const id = (r.pact_id ?? r.id) as string | undefined;
      if (r.status === 'active' && typeof id === 'string' && !pactSessions.has(id)) {
        try {
          const full = (await pactsApi.getPact(id)).data.result;
          capturePactSession(full);
        } catch {
          // Best-effort capture; agent can call get_pact explicitly to retry.
        }
      }
    }
    return result;
  },
});

const getPact = tool({
  name: 'get_pact',
  description: 'Fetch the current state of a pact, including its status and api_key once active.',
  parameters: z.object({
    pact_id: z.string(),
  }),
  async execute({ pact_id }) {
    const response = await pactsApi.getPact(pact_id);
    capturePactSession(response.data.result);
    return response.data.result;
  },
});

const estimateTransferFee = tool({
  name: 'estimate_transfer_fee',
  description: 'Estimate fees for a token transfer before submitting it.',
  parameters: z.object({
    wallet_uuid: z.string(),
    dst_addr: z.string(),
    token_id: z.string(),
    amount: z.string(),
    pact_id: z
      .string()
      .nullable()
      .describe(
        'Pact id from submit_pact / get_pact. Pass it to estimate under pact-scoped permissions.',
      ),
  }),
  async execute({ wallet_uuid, dst_addr, token_id, amount, pact_id }) {
    const api = txApiFor(pact_id ?? undefined);
    const response = await api.estimateTransferFee(wallet_uuid, {
      chain_id: CHAIN_ID,
      dst_addr,
      token_id,
      amount,
    });
    return response.data.result;
  },
});

const transferTokens = tool({
  name: 'transfer_tokens',
  description: 'Execute a policy-enforced transfer.',
  parameters: z.object({
    wallet_uuid: z.string(),
    dst_addr: z.string(),
    token_id: z.string(),
    amount: z.string(),
    request_id: z.string(),
    pact_id: z
      .string()
      .nullable()
      .describe(
        'Pact id from submit_pact / get_pact. REQUIRED to invoke under pact-scoped policy permissions.',
      ),
  }),
  async execute({ wallet_uuid, dst_addr, token_id, amount, request_id, pact_id }) {
    return await returnPolicyDenial(async () => {
      const api = txApiFor(pact_id ?? undefined);
      const response = await api.transferTokens(wallet_uuid, {
        chain_id: CHAIN_ID,
        dst_addr,
        token_id,
        amount,
        request_id,
      });
      return response.data.result;
    });
  },
});

const getTransactionRecordByRequestId = tool({
  name: 'get_transaction_record_by_request_id',
  description: 'Look up a transaction record by request id.',
  parameters: z.object({
    wallet_uuid: z.string(),
    request_id: z.string(),
  }),
  async execute({ wallet_uuid, request_id }) {
    const response = await recordsApi.getUserTransactionByRequestId(wallet_uuid, request_id);
    return response.data.result;
  },
});

const getAuditLogs = tool({
  name: 'get_audit_logs',
  description: 'List recent audit log entries for the wallet.',
  parameters: z.object({
    wallet_id: z.string(),
    limit: z.number().int().positive().nullable(),
  }),
  async execute({ wallet_id, limit }) {
    const response = await auditApi.listAuditLogs(
      wallet_id,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      limit ?? 20,
    );
    return response.data.result;
  },
});

const tools = [
  submitPact,
  getPact,
  transferTokens,
  estimateTransferFee,
  getTransactionRecordByRequestId,
  getAuditLogs,
];

console.log('Registered Cobo OpenAI tools:');
for (const t of tools) {
  console.log(`  - ${t.name}: ${t.description}`);
}

if (!process.env.OPENAI_API_KEY) {
  console.log('\nSet OPENAI_API_KEY to run a full OpenAI agent demo prompt.');
  process.exit(0);
}

const agent = new Agent({
  name: 'cobo-operator',
  model: 'gpt-4.1-mini',
  instructions:
    'Submit a pact before execution, wait until it is active, execute a compliant blockchain action, and if a tool returns a policy denial then follow the suggestion and retry.',
  tools,
});

const walletId = process.env.AGENT_WALLET_WALLET_ID!;
const destination =
  process.env.CAW_DESTINATION ?? '0x1111111111111111111111111111111111111111';

const prompt =
  `Use wallet ${walletId}. ` +
  `Submit a pact for a controlled transfer task and wait until it is active. ` +
  `Using the newly created pact, transfer 0.001 ${TOKEN_ID} to ${destination} on ${CHAIN_ID}. ` +
  `Next, using the same pact, attempt 0.005 ${TOKEN_ID}. If denied, follow the denial ` +
  `guidance and retry with a compliant amount. ` +
  `Track the result by request_id and summarize what happened.`;

const result = await run(agent, prompt, { maxTurns: 20 });

console.log('\nAgent result:', result.finalOutput);
