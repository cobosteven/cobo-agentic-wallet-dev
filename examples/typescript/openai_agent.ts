/**
 * OpenAI Agents SDK example using the current pact-first CAW usage model.
 *
 * What is specific to `@openai/agents` (and therefore stays in this file):
 *   - the `tool({...})` DSL — note: strict-schema mode requires `.nullable()`
 *     rather than `.optional()` for every optional field,
 *   - the `new Agent(...)` config,
 *   - the shape of `RunResult.history`, which interleaves
 *     `function_call` and `function_call_result` items.
 *
 * Shared infra (env, clients, pact spec, session store, denial handling,
 * pretty-print helpers) lives in `./lib`.
 */

import { randomUUID } from 'node:crypto';
import { Agent, run, tool } from '@openai/agents';
import { z } from 'zod';

import { DemoContext } from './lib/context';
import { listRecentAuditLogs } from './lib/clients';
import { buildTransferPactSpec, CHAIN_ID } from './lib/pact-spec';
import { returnPolicyDenial } from './lib/errors';
import { DEMO_SYSTEM_PROMPT, buildDemoPrompt } from './lib/prompt';
import {
  printToolCalls,
  printFinalAnswer,
  type ToolCallRecord,
} from './lib/printer';

const ctx = DemoContext.load();

// ─── Tool definitions ────────────────────────────────────────────────────────

const submitPact = tool({
  name: 'submit_pact',
  description: 'Submit a pact and return the pact id.',
  parameters: z.object({
    wallet_id: z.string(),
    intent: z.string(),
  }),
  async execute({ wallet_id, intent }) {
    const response = await ctx.apis.pactsApi.submitPact({
      wallet_id,
      intent,
      spec: buildTransferPactSpec(),
    });
    const result = response.data.result;
    ctx.sessions.capture(result);
    await ctx.backfillPactSessionIfActive(result);
    return result;
  },
});

const getPact = tool({
  name: 'get_pact',
  description: 'Fetch a pact, including its status and api_key once active.',
  parameters: z.object({ pact_id: z.string() }),
  async execute({ pact_id }) {
    const response = await ctx.apis.pactsApi.getPact(pact_id);
    ctx.sessions.capture(response.data.result);
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
    const api = ctx.sessions.txApiFor(pact_id ?? undefined);
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
      .describe(
        'Pact id from submit_pact / get_pact. REQUIRED to invoke under pact-scoped policy permissions.',
      ),
  }),
  async execute({ wallet_uuid, dst_addr, token_id, amount, pact_id }) {
    return returnPolicyDenial(async () => {
      const api = ctx.sessions.txApiFor(pact_id ?? undefined);
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
    const response = await ctx.apis.recordsApi.getUserTransactionByRequestId(
      wallet_uuid,
      request_id,
    );
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
    return listRecentAuditLogs(ctx.apis.auditApi, wallet_id, limit ?? 20);
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

if (!ctx.env.openaiApiKey) {
  console.log('\nSet OPENAI_API_KEY to run a full agent demo prompt.');
  process.exit(0);
}

const agent = new Agent({
  name: 'cobo-operator',
  model: 'gpt-4.1-mini',
  instructions: DEMO_SYSTEM_PROMPT,
  tools,
});

const result = await run(agent, buildDemoPrompt(ctx.env), { maxTurns: 20 });

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
      existing.result =
        res.output && 'text' in res.output ? res.output.text : res.output;
    }
  }

  return [...byCallId.values()];
}

const history = ((result as { history?: HistoryItem[] }).history ?? []) as HistoryItem[];
printToolCalls(toRecords(history));
printFinalAnswer(
  typeof result.finalOutput === 'string' ? result.finalOutput : JSON.stringify(result.finalOutput),
);
