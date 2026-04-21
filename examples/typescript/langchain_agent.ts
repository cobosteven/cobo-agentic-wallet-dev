/**
 * LangChain example using the current pact-first CAW usage model.
 *
 * This file is self-contained: copy it to a fresh project (plus the package
 * dependencies listed in README.md), set the env vars, and run it.
 *
 * What is specific to LangChain (and therefore framework-specific in this file):
 *   - how a `tool(...)` is declared with a Zod schema,
 *   - how `createAgent(...)` is wired,
 *   - how the returned `result.messages[]` encodes tool calls and results.
 */

import { randomUUID } from 'node:crypto';
import { tool, createAgent } from 'langchain';
import { z } from 'zod';

import {
  AuditApi,
  Configuration,
  type PactSpecInput,
  PactsApi,
  TransactionRecordsApi,
  TransactionsApi,
} from '@cobo/agentic-wallet';

// ─── Env ─────────────────────────────────────────────────────────────────────

const DEFAULT_DESTINATION = '0x1111111111111111111111111111111111111111';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}. See README.md for the full list.`);
  return v;
}

const env = {
  basePath: requireEnv('AGENT_WALLET_API_URL'),
  ownerKey: requireEnv('AGENT_WALLET_API_KEY'),
  walletId: requireEnv('AGENT_WALLET_WALLET_ID'),
  destination: process.env.CAW_DESTINATION ?? DEFAULT_DESTINATION,
  openaiApiKey: process.env.OPENAI_API_KEY,
};

// ─── Owner-scoped API clients ────────────────────────────────────────────────

const ownerConfig = new Configuration({ apiKey: env.ownerKey, basePath: env.basePath });
const pactsApi = new PactsApi(ownerConfig);
const ownerTxApi = new TransactionsApi(ownerConfig);
const recordsApi = new TransactionRecordsApi(ownerConfig);
const auditApi = new AuditApi(ownerConfig);

// ─── Pact spec (single source of truth for the demo policy) ──────────────────

const CHAIN_ID = 'SETH';
const TOKEN_ID = 'SETH';
const DENY_THRESHOLD = '0.002';
const PACT_TTL_SECONDS = '86400';

function buildTransferPactSpec(): PactSpecInput {
  return {
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
    completion_conditions: [{ type: 'time_elapsed', threshold: PACT_TTL_SECONDS }],
  };
}

// ─── Pact session store ──────────────────────────────────────────────────────
// Tracks pact_id → pact-scoped api_key across the agent run, and lazily
// materialises per-pact TransactionsApi clients. Agent tools register pacts
// via `capturePactSession()` as they are submitted/fetched, then look up
// the scoped client by pact_id at transfer time via `txApiForPact()`.

const sessionApiKeys = new Map<string, string>();
const pactScopedTxApis = new Map<string, TransactionsApi>();

function capturePactSession(response: unknown): void {
  if (!response || typeof response !== 'object') return;
  const r = response as Record<string, unknown>;
  const pactId = (r.pact_id ?? r.id) as string | undefined;
  const apiKey = r.api_key as string | undefined;
  if (typeof pactId === 'string' && typeof apiKey === 'string' && apiKey) {
    sessionApiKeys.set(pactId, apiKey);
  }
}

function txApiForPact(pactId?: string): TransactionsApi {
  if (!pactId) return ownerTxApi;
  const cached = pactScopedTxApis.get(pactId);
  if (cached) return cached;
  const apiKey = sessionApiKeys.get(pactId);
  if (!apiKey) {
    throw new Error(
      `Unknown pact_id ${pactId}. Call submit_pact or get_pact first ` +
        `so the pact-scoped api_key is captured, then retry.`,
    );
  }
  const scoped = new TransactionsApi(new Configuration({ apiKey, basePath: env.basePath }));
  pactScopedTxApis.set(pactId, scoped);
  return scoped;
}

/**
 * After `submit_pact`, auto-activated pacts may carry `status=active` but
 * omit `api_key` from the initial response. This helper fills the gap by
 * fetching the full pact record and capturing the scoped api_key so that
 * subsequent transfer tool calls can resolve `pact_id → TransactionsApi`.
 */
async function backfillPactSessionIfActive(result: unknown): Promise<void> {
  if (!result || typeof result !== 'object') return;
  const r = result as Record<string, unknown>;
  const id = (r.pact_id ?? r.id) as string | undefined;
  if (r.status !== 'active' || !id || sessionApiKeys.has(id)) return;
  try {
    const full = (await pactsApi.getPact(id)).data.result;
    capturePactSession(full);
  } catch {
    // best-effort
  }
}

// ─── Denial handling ─────────────────────────────────────────────────────────
// The service returns denials as structured `{ error, suggestion }` payloads
// on non-2xx responses. Agent tools surface those payloads back to the LLM
// so it can self-correct, rather than aborting the agent loop.

interface DenialEnvelope {
  error: Record<string, unknown> | string;
  suggestion?: string;
}

function parseApiError(err: unknown): {
  http: number | '-';
  error?: Record<string, unknown>;
  suggestion?: string;
} {
  const resp = (
    err as {
      response?: {
        status?: number;
        data?: { error?: Record<string, unknown>; suggestion?: string };
      };
    } | null | undefined
  )?.response;
  return { http: resp?.status ?? '-', error: resp?.data?.error, suggestion: resp?.data?.suggestion };
}

async function returnPolicyDenial<T>(work: () => Promise<T>): Promise<T | DenialEnvelope> {
  try {
    return await work();
  } catch (err) {
    const { error, suggestion } = parseApiError(err);
    return error ? { error, suggestion } : { error: 'UNKNOWN_ERROR' };
  }
}

// ─── Audit-log helper ────────────────────────────────────────────────────────

async function listRecentAuditLogs(walletId: string, limit = 20) {
  const response = await auditApi.listAuditLogs(
    walletId,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    limit,
  );
  const items = (response.data.result as { items?: Array<{ result?: string }> })?.items ?? [];
  const allowed = items.filter(it => it.result === 'allowed').length;
  const denied = items.filter(it => it.result === 'denied').length;
  return { items, allowed, denied };
}

// ─── Prompts ─────────────────────────────────────────────────────────────────

const DEMO_SYSTEM_PROMPT =
  'Submit a pact before execution, wait until it is active, execute compliant ' +
  'blockchain actions, and if a tool returns policy denial guidance then retry ' +
  'inside the allowed boundary.';

const DEMO_USER_PROMPT =
  `Use wallet ${env.walletId}. ` +
  `Submit a pact for a controlled transfer task and wait until it is active. ` +
  `Using the newly created pact, transfer 0.001 ${TOKEN_ID} to ${env.destination} on ${CHAIN_ID}. ` +
  `Next, using the same pact, attempt 0.005 ${TOKEN_ID}. If denied, follow the denial ` +
  `guidance and retry with a compliant amount. ` +
  `Track the result by request_id and summarize what happened.`;

// ─── Pretty-printing ─────────────────────────────────────────────────────────

interface ToolCallRecord {
  name: string;
  args?: Record<string, unknown>;
  result?: unknown;
}

const NOISY_ARG_KEYS = new Set<string>(['wallet_uuid', 'wallet_id']);

function truncate(value: unknown, limit = 120): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined) return '';
  return text.length <= limit ? text : text.slice(0, limit - 1) + '…';
}

function formatToolArgs(args: Record<string, unknown> | undefined): string {
  if (!args) return '-';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (NOISY_ARG_KEYS.has(k)) continue;
    parts.push(`${k}=${truncate(v, 80)}`);
  }
  return parts.join(', ') || '-';
}

function summariseToolResult(raw: unknown): string {
  if (raw === undefined || raw === null) return '(no result)';
  let payload: unknown = raw;
  if (typeof raw === 'string') {
    try {
      payload = JSON.parse(raw);
    } catch {
      return truncate(raw.replace(/\n/g, ' '));
    }
  }
  if (!payload || typeof payload !== 'object') return truncate(payload);

  const p = payload as Record<string, unknown>;
  if ('pact_id' in p && 'status' in p && !('request_id' in p) && !('spec' in p)) {
    return `pact_id=${truncate(p.pact_id, 36)} status=${p.status}`;
  }
  if ('id' in p && 'status' in p && 'spec' in p) {
    return `pact_id=${truncate(p.id, 36)} status=${p.status} api_key=${p.api_key ? 'present' : 'null'}`;
  }
  if ('request_id' in p) {
    const bits: string[] = [`request_id=${truncate(p.request_id, 36)}`];
    if (p.status_display) bits.push(`status=${p.status_display}`);
    else if ('status' in p) bits.push(`status=${p.status}`);
    if (p.transaction_hash) bits.push(`hash=${p.transaction_hash}`);
    return bits.join(' ');
  }
  if ('fee' in p || 'gas_price' in p || 'estimated_fee' in p) {
    return `fee=${truncate(p.fee ?? p.estimated_fee ?? p.gas_price)}`;
  }
  if ('items' in p && Array.isArray(p.items) && 'allowed' in p && 'denied' in p) {
    return `audit entries=${p.items.length} allowed=${p.allowed} denied=${p.denied}`;
  }
  if ('error' in p) {
    const err = p.error;
    if (err && typeof err === 'object') {
      const e = err as { code?: string; reason?: string; message?: string };
      const code = e.code ?? '-';
      const reason = e.reason ?? e.message ?? '-';
      const sug = p.suggestion ? ` suggestion=${truncate(p.suggestion, 80)}` : '';
      if (code === '-' && reason === '-') return `DENIED raw=${truncate(err, 100)}${sug}`;
      return `DENIED code=${code} reason=${reason}${sug}`;
    }
    return `ERROR ${err}`;
  }
  return truncate(p);
}

function printToolCalls(records: ToolCallRecord[]): void {
  console.log('\nTool calls:');
  if (records.length === 0) {
    console.log('  (none)');
    return;
  }
  records.forEach((call, idx) => {
    console.log(`  ${idx + 1}. ${call.name}(${formatToolArgs(call.args)})`);
    console.log(`     → ${summariseToolResult(call.result)}`);
  });
}

function printFinalAnswer(text: string | undefined): void {
  console.log('\nFinal answer:');
  console.log(text || '(no final answer produced)');
}

// ─── Tool definitions (LangChain-specific) ───────────────────────────────────

const submitPact = tool(
  async ({ wallet_id, intent }) => {
    const response = await pactsApi.submitPact({
      wallet_id,
      intent,
      spec: buildTransferPactSpec(),
    });
    const result = response.data.result;
    capturePactSession(result);
    await backfillPactSessionIfActive(result);
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
    description: 'Fetch a pact, including its status and api_key once active.',
    schema: z.object({ pact_id: z.string() }),
  },
);

const estimateTransferFee = tool(
  async ({ wallet_uuid, dst_addr, token_id, amount, pact_id }) => {
    const api = txApiForPact(pact_id);
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
        .describe('Pact id. Pass it to estimate under pact-scoped permissions.'),
    }),
  },
);

const transferTokens = tool(
  async ({ wallet_uuid, dst_addr, token_id, amount, pact_id }) => {
    return returnPolicyDenial(async () => {
      const api = txApiForPact(pact_id);
      const response = await api.transferTokens(wallet_uuid, {
        chain_id: CHAIN_ID,
        dst_addr,
        token_id,
        amount,
        request_id: randomUUID(),
      });
      return response.data.result;
    });
  },
  {
    name: 'transfer_tokens',
    description:
      'Execute a policy-enforced transfer. A unique request_id is auto-generated ' +
      'and returned in the response; use that value to track or look up the tx later.',
    schema: z.object({
      wallet_uuid: z.string(),
      dst_addr: z.string(),
      token_id: z.string(),
      amount: z.string(),
      pact_id: z
        .string()
        .optional()
        .describe('Pact id from submit_pact / get_pact. REQUIRED to invoke under pact-scoped policy permissions.'),
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
  async ({ wallet_id, limit }) => listRecentAuditLogs(wallet_id, limit),
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

// ─── Boot ────────────────────────────────────────────────────────────────────

console.log('Registered Cobo LangChain tools:');
for (const t of tools) {
  console.log(`  - ${t.name}: ${t.description}`);
}

if (!env.openaiApiKey) {
  console.log('\nSet OPENAI_API_KEY to run a full agent demo prompt.');
  process.exit(0);
}

const agent = createAgent({
  model: 'openai:gpt-4.1-mini',
  tools,
  systemPrompt: DEMO_SYSTEM_PROMPT,
});

const result = await agent.invoke({
  messages: [{ role: 'user', content: DEMO_USER_PROMPT }],
});

// ─── LangChain → ToolCallRecord adapter ──────────────────────────────────────
// LangChain threads each tool call into the message list: an AI message holds
// one or more `tool_calls` entries, and the corresponding tool response
// carries the same `tool_call_id`. We pair them up into `ToolCallRecord`s and
// also extract the last assistant message without any tool plumbing as the
// "final answer".

interface LangChainMessage {
  tool_calls?: { id: string; name: string; args?: Record<string, unknown> }[];
  tool_call_id?: string;
  content?: string;
}

function toRecords(messages: LangChainMessage[]): ToolCallRecord[] {
  const byId = new Map<string, ToolCallRecord>();
  for (const msg of messages) {
    for (const tc of msg.tool_calls ?? []) {
      byId.set(tc.id, { name: tc.name, args: tc.args });
    }
    if (msg.tool_call_id && byId.has(msg.tool_call_id)) {
      byId.get(msg.tool_call_id)!.result = msg.content ?? '';
    }
  }
  return [...byId.values()];
}

function extractFinalText(messages: LangChainMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.content && !m.tool_call_id && !(m.tool_calls ?? []).length) {
      return m.content;
    }
  }
  return undefined;
}

const messages = ((result as { messages?: LangChainMessage[] }).messages ?? []) as LangChainMessage[];
printToolCalls(toRecords(messages));
printFinalAnswer(extractFinalText(messages));
