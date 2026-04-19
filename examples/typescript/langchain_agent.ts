/**
 * LangChain example using the current pact-first CAW usage model.
 */

import { tool } from 'langchain';
import { createAgent } from 'langchain';
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

const submitPact = tool(
  async ({ wallet_id, intent }) => {
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
  {
    name: 'submit_pact',
    description: 'Submit a pact and return the pact id.',
    schema: z.object({
      wallet_id: z.string(),
      intent: z.string(),
    }),
  },
);

const getPact = tool(
  async ({ pact_id }) => {
    const response = await pactsApi.getPact(pact_id);
    capturePactSession(response.data.result);
    return response.data.result;
  },
  {
    name: 'get_pact',
    description: 'Fetch the current state of a pact, including its status and api_key once active.',
    schema: z.object({
      pact_id: z.string(),
    }),
  },
);

const estimateTransferFee = tool(
  async ({ wallet_uuid, dst_addr, token_id, amount, pact_id }) => {
    const api = txApiFor(pact_id);
    const response = await api.estimateTransferFee(wallet_uuid, {
      chain_id: CHAIN_ID,
      dst_addr,
      token_id,
      amount,
    });
    return response.data.result;
  },
  {
    name: 'estimate_transfer_fee',
    description: 'Estimate fees for a token transfer before submitting it.',
    schema: z.object({
      wallet_uuid: z.string(),
      dst_addr: z.string(),
      token_id: z.string(),
      amount: z.string(),
      pact_id: z
        .string()
        .optional()
        .describe(
          'Pact id from submit_pact / get_pact. Pass it to estimate under pact-scoped permissions.',
        ),
    }),
  },
);

const transferTokens = tool(
  async ({ wallet_uuid, dst_addr, token_id, amount, request_id, pact_id }) => {
    return await returnPolicyDenial(async () => {
      const api = txApiFor(pact_id);
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
  {
    name: 'transfer_tokens',
    description: 'Execute a policy-enforced transfer.',
    schema: z.object({
      wallet_uuid: z.string(),
      dst_addr: z.string(),
      token_id: z.string(),
      amount: z.string(),
      request_id: z.string(),
      pact_id: z
        .string()
        .optional()
        .describe(
          'Pact id from submit_pact / get_pact. REQUIRED to invoke under pact-scoped policy permissions.',
        ),
    }),
  },
);

const getTransactionRecordByRequestId = tool(
  async ({ wallet_uuid, request_id }) => {
    const response = await recordsApi.getUserTransactionByRequestId(wallet_uuid, request_id);
    return response.data.result;
  },
  {
    name: 'get_transaction_record_by_request_id',
    description: 'Look up a transaction record by request id.',
    schema: z.object({
      wallet_uuid: z.string(),
      request_id: z.string(),
    }),
  },
);

const getAuditLogs = tool(
  async ({ wallet_id, limit }) => {
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
  {
    name: 'get_audit_logs',
    description: 'List recent audit log entries for the wallet.',
    schema: z.object({
      wallet_id: z.string(),
      limit: z.number().int().positive().optional(),
    }),
  },
);

const tools = [
  submitPact,
  getPact,
  transferTokens,
  estimateTransferFee,
  getTransactionRecordByRequestId,
  getAuditLogs,
];

const walletId = process.env.AGENT_WALLET_WALLET_ID!;
const destination =
  process.env.CAW_DESTINATION ?? '0x1111111111111111111111111111111111111111';

console.log('Registered Cobo LangChain tools:');
for (const t of tools) {
  console.log(`  - ${t.name}: ${t.description}`);
}

if (!process.env.OPENAI_API_KEY) {
  console.log('\nSet OPENAI_API_KEY to run a full agent demo prompt.');
  process.exit(0);
}

const agent = createAgent({
  model: 'openai:gpt-4.1-mini',
  tools,
  systemPrompt:
    'Submit a pact before execution, wait until it is active, execute compliant blockchain actions, and if a tool returns policy denial guidance then retry inside the allowed boundary.',
});

const prompt =
  `Use wallet ${walletId}. ` +
  `Submit a pact for a controlled transfer task and wait until it is active. ` +
  `Using the newly created pact, transfer 0.001 ${TOKEN_ID} to ${destination} on ${CHAIN_ID}. ` +
  `Next, using the same pact, attempt 0.005 ${TOKEN_ID}. If denied, follow the denial ` +
  `guidance and retry with a compliant amount. ` +
  `Track the result by request_id and summarize what happened.`;

interface ToolCallInfo {
  name: string;
  args: Record<string, unknown>;
  result?: string;
}

interface AgentMessage {
  tool_calls?: { id: string; name: string; args?: Record<string, unknown> }[];
  tool_call_id?: string;
  content?: string;
}

function truncate(value: unknown, limit = 120): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length <= limit ? text : text.slice(0, limit - 1) + '…';
}

function formatToolArgs(args: Record<string, unknown>): string {
  const skip = new Set(['wallet_uuid', 'wallet_id']);
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (skip.has(k)) continue;
    parts.push(`${k}=${truncate(v, 60)}`);
  }
  return parts.join(', ') || '-';
}

function summariseToolResult(raw: string | undefined): string {
  if (!raw) return '(no result)';
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return truncate(raw.replace(/\n/g, ' '));
  }
  if (!payload || typeof payload !== 'object') return truncate(payload);
  const p = payload as Record<string, unknown>;
  // submit_pact result envelope: { pact_id, status, approval_id?, message? }
  if ('pact_id' in p && 'status' in p && !('request_id' in p) && !('spec' in p)) {
    return `pact_id=${truncate(p.pact_id, 36)} status=${p.status}`;
  }
  // get_pact result: full pact record (contains id + spec)
  if ('id' in p && 'status' in p && 'spec' in p) {
    return (
      `pact_id=${truncate(p.id, 36)} status=${p.status} ` +
      `api_key=${p.api_key ? 'present' : 'null'}`
    );
  }
  // transfer / record result
  if ('request_id' in p) {
    const bits: string[] = [`request_id=${truncate(p.request_id, 36)}`];
    if (p.status_display) bits.push(`status=${p.status_display}`);
    else if ('status' in p) bits.push(`status=${p.status}`);
    if (p.transaction_hash) bits.push(`hash=${p.transaction_hash}`);
    return bits.join(' ');
  }
  // estimate fee result
  if ('fee' in p || 'gas_price' in p || 'estimated_fee' in p) {
    return `fee=${truncate(p.fee ?? p.estimated_fee ?? p.gas_price)}`;
  }
  // audit logs page
  if ('items' in p && Array.isArray(p.items)) {
    const items = p.items as { result?: string }[];
    const allowed = items.filter(it => it.result === 'allowed').length;
    const denied = items.filter(it => it.result === 'denied').length;
    return `audit entries=${items.length} allowed=${allowed} denied=${denied}`;
  }
  // structured policy denial wrapped by returnPolicyDenial
  if ('error' in p) {
    const err = p.error;
    if (err && typeof err === 'object') {
      const e = err as { code?: string; reason?: string };
      const sug = p.suggestion ? ` suggestion=${truncate(p.suggestion, 80)}` : '';
      return `DENIED code=${e.code ?? '-'} reason=${e.reason ?? '-'}${sug}`;
    }
    return `ERROR ${err}`;
  }
  return truncate(p);
}

function printAgentResult(result: unknown): void {
  const messages = ((result as { messages?: AgentMessage[] })?.messages ?? []) as AgentMessage[];
  const toolCalls = new Map<string, ToolCallInfo>();
  let finalText = '';

  for (const msg of messages) {
    const tcs = msg.tool_calls ?? [];
    for (const tc of tcs) {
      toolCalls.set(tc.id, { name: tc.name, args: tc.args ?? {} });
    }
    const tcId = msg.tool_call_id;
    if (tcId && toolCalls.has(tcId)) {
      toolCalls.get(tcId)!.result = msg.content ?? '';
    }
    const content = msg.content ?? '';
    if (content && tcs.length === 0 && !tcId) {
      finalText = content;
    }
  }

  console.log('\nTool calls:');
  if (toolCalls.size === 0) {
    console.log('  (none)');
  }
  let idx = 1;
  for (const call of toolCalls.values()) {
    const args = formatToolArgs(call.args);
    const summary = summariseToolResult(call.result);
    console.log(`  ${idx}. ${call.name}(${args})`);
    console.log(`     → ${summary}`);
    idx++;
  }

  console.log('\nFinal answer:');
  console.log(finalText || '(no final answer produced)');
}

const result = await agent.invoke({
  messages: [{ role: 'user', content: prompt }],
});

printAgentResult(result);
