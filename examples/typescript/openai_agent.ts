/**
 * OpenAI Agents SDK example using the current pact-first CAW usage model.
 *
 * This file is self-contained: copy it to a fresh project (plus the package
 * dependencies listed in README.md), set the env vars, and run it.
 *
 * What is specific to `@openai/agents` (and therefore framework-specific in this file):
 *   - the `tool({...})` DSL — note: strict-schema mode requires `.nullable()`
 *     rather than `.optional()` for every optional field,
 *   - the `new Agent(...)` config,
 *   - the shape of `RunResult.history`, which interleaves
 *     `function_call` and `function_call_result` items.
 */

import { randomUUID } from 'node:crypto';
import { Agent, run, tool } from '@openai/agents';
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

// ─── Tool definitions (@openai/agents-specific) ──────────────────────────────

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
      spec: buildTransferPactSpec(),
    });
    const result = response.data.result;
    capturePactSession(result);
    await backfillPactSessionIfActive(result);
    return result;
  },
});

const getPact = tool({
  name: 'get_pact',
  description: 'Fetch a pact, including its status and api_key once active.',
  parameters: z.object({ pact_id: z.string() }),
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
      .describe('Pact id. Pass it to estimate under pact-scoped permissions.'),
  }),
  async execute({ wallet_uuid, dst_addr, token_id, amount, pact_id }) {
    const api = txApiForPact(pact_id ?? undefined);
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
  description:
    'Execute a policy-enforced transfer. A unique request_id is auto-generated ' +
    'and returned in the response; use that value to track or look up the tx later.',
  parameters: z.object({
    wallet_uuid: z.string(),
    dst_addr: z.string(),
    token_id: z.string(),
    amount: z.string(),
    pact_id: z
      .string()
      .nullable()
      .describe('Pact id from submit_pact / get_pact. REQUIRED to invoke under pact-scoped policy permissions.'),
  }),
  async execute({ wallet_uuid, dst_addr, token_id, amount, pact_id }) {
    return returnPolicyDenial(async () => {
      const api = txApiForPact(pact_id ?? undefined);
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
    return listRecentAuditLogs(wallet_id, limit ?? 20);
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

// ─── Boot ────────────────────────────────────────────────────────────────────

console.log('Registered Cobo OpenAI tools:');
for (const t of tools) {
  console.log(`  - ${t.name}: ${t.description}`);
}

if (!env.openaiApiKey) {
  console.log('\nSet OPENAI_API_KEY to run a full agent demo prompt.');
  process.exit(0);
}

const agent = new Agent({
  name: 'cobo-operator',
  model: 'gpt-4.1-mini',
  instructions: DEMO_SYSTEM_PROMPT,
  tools,
});

const result = await run(agent, DEMO_USER_PROMPT, { maxTurns: 20 });

// ─── @openai/agents → ToolCallRecord adapter ─────────────────────────────────
// `RunResult.history` interleaves `function_call` items (with stringified
// `arguments`) and matching `function_call_result` items (with `output.text`).
// We pair them by `callId` and parse the argument JSON once.

interface FunctionCallItem {
  type: 'function_call';
  callId: string;
  name: string;
  arguments: string;
}

interface FunctionCallResultItem {
  type: 'function_call_result';
  callId: string;
  output: { type: 'text'; text: string } | { type: 'image'; data: string };
}

type HistoryItem = FunctionCallItem | FunctionCallResultItem | { type: string };

function toRecords(history: HistoryItem[]): ToolCallRecord[] {
  const byCallId = new Map<string, ToolCallRecord>();
  for (const item of history) {
    if (item.type === 'function_call') {
      const call = item as FunctionCallItem;
      let args: Record<string, unknown> | undefined;
      try {
        args = call.arguments ? JSON.parse(call.arguments) : undefined;
      } catch {
        args = undefined;
      }
      byCallId.set(call.callId, { name: call.name, args });
    } else if (item.type === 'function_call_result') {
      const res = item as FunctionCallResultItem;
      const existing = byCallId.get(res.callId);
      if (!existing) continue;
      existing.result = res.output && 'text' in res.output ? res.output.text : res.output;
    }
  }
  return [...byCallId.values()];
}

const history = ((result as { history?: HistoryItem[] }).history ?? []) as HistoryItem[];
printToolCalls(toRecords(history));
printFinalAnswer(
  typeof result.finalOutput === 'string' ? result.finalOutput : JSON.stringify(result.finalOutput),
);
