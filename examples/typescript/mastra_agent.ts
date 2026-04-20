/**
 * Mastra example using the current pact-first CAW usage model.
 *
 * What is specific to `@mastra/core` (and therefore stays in this file):
 *   - the `createTool({...})` DSL with Zod `inputSchema`,
 *   - the `new Agent({ tools: { ... } })` shape — tools go into a record,
 *   - the `agent.generate(prompt)` output with separate `toolCalls` and
 *     `toolResults` arrays, each wrapping items in a `payload` field.
 *
 * Shared infra lives in `./lib`.
 */

import { randomUUID } from 'node:crypto';

import { openai } from '@ai-sdk/openai';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
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

const submitPactTool = createTool({
  id: 'submit_pact',
  description: 'Submit a pact and return the pact id.',
  inputSchema: z.object({
    wallet_id: z.string(),
    intent: z.string(),
  }),
  execute: async (input) => {
    const response = await ctx.apis.pactsApi.submitPact({
      wallet_id: input.wallet_id,
      intent: input.intent,
      spec: buildTransferPactSpec(),
    });
    const result = response.data.result;
    ctx.sessions.capture(result);
    await ctx.backfillPactSessionIfActive(result);
    return result;
  },
});

const getPactTool = createTool({
  id: 'get_pact',
  description: 'Fetch a pact, including its status and api_key once active.',
  inputSchema: z.object({ pact_id: z.string() }),
  execute: async (input) => {
    const response = await ctx.apis.pactsApi.getPact(input.pact_id);
    ctx.sessions.capture(response.data.result);
    return response.data.result;
  },
});

const estimateTransferFeeTool = createTool({
  id: 'estimate_transfer_fee',
  description: 'Estimate fees for a token transfer before submitting it.',
  inputSchema: z.object({
    wallet_uuid: z.string(),
    dst_addr: z.string(),
    token_id: z.string(),
    amount: z.string(),
    pact_id: z
      .string()
      .optional()
      .describe('Pact id. Pass it to estimate under pact-scoped permissions.'),
  }),
  execute: async (input) => {
    const api = ctx.sessions.txApiFor(input.pact_id);
    const response = await api.estimateTransferFee(input.wallet_uuid, {
      chain_id: CHAIN_ID,
      dst_addr: input.dst_addr,
      token_id: input.token_id,
      amount: input.amount,
    });
    return response.data.result;
  },
});

const transferTool = createTool({
  id: 'transfer_tokens',
  description:
    'Execute a policy-enforced transfer. A unique request_id is auto-generated ' +
    'and returned in the response; use that value to track or look up the tx later.',
  inputSchema: z.object({
    wallet_uuid: z.string(),
    dst_addr: z.string(),
    token_id: z.string(),
    amount: z.string(),
    pact_id: z
      .string()
      .optional()
      .describe(
        'Pact id from submit_pact / get_pact. REQUIRED to invoke under pact-scoped policy permissions.',
      ),
  }),
  execute: async (input) => {
    return returnPolicyDenial(async () => {
      const api = ctx.sessions.txApiFor(input.pact_id);
      const response = await api.transferTokens(input.wallet_uuid, {
        chain_id: CHAIN_ID,
        dst_addr: input.dst_addr,
        token_id: input.token_id,
        amount: input.amount,
        request_id: randomUUID(),
      });
      return response.data.result;
    });
  },
});

const recordTool = createTool({
  id: 'get_transaction_record_by_request_id',
  description: 'Look up a transaction record by request id.',
  inputSchema: z.object({
    wallet_uuid: z.string(),
    request_id: z.string(),
  }),
  execute: async (input) => {
    const response = await ctx.apis.recordsApi.getUserTransactionByRequestId(
      input.wallet_uuid,
      input.request_id,
    );
    return response.data.result;
  },
});

const auditTool = createTool({
  id: 'get_audit_logs',
  description: 'List recent audit log entries for the wallet.',
  inputSchema: z.object({
    wallet_id: z.string(),
    limit: z.number().int().positive().optional(),
  }),
  execute: async (input) =>
    listRecentAuditLogs(ctx.apis.auditApi, input.wallet_id, input.limit),
});

const tools = {
  submitPactTool,
  getPactTool,
  estimateTransferFeeTool,
  transferTool,
  recordTool,
  auditTool,
};

// ─── Boot ────────────────────────────────────────────────────────────────────

console.log('Registered Cobo Mastra tools:');
for (const [key, t] of Object.entries(tools)) {
  console.log(`  - ${key} (${t.id}): ${t.description}`);
}

if (!ctx.env.openaiApiKey) {
  console.log('\nSet OPENAI_API_KEY to run a full agent demo prompt.');
  process.exit(0);
}

const agent = new Agent({
  id: 'cobo-operator',
  name: 'cobo-operator',
  model: openai('gpt-4.1-mini'),
  instructions: DEMO_SYSTEM_PROMPT,
  tools,
});

// `maxSteps` caps how many model→tool→model loops Mastra runs. The demo takes
// up to a dozen tool calls (pact lifecycle + retries) and the final summary
// message counts as an extra step, so give it generous headroom.
const output = await agent.generate(buildDemoPrompt(ctx.env), { maxSteps: 20 });

// ─── Mastra → ToolCallRecord adapter ─────────────────────────────────────────
// `agent.generate()` returns `toolCalls` and `toolResults` as two parallel
// arrays. Each entry wraps its data in a `payload` with a stable `toolCallId`,
// which we use to pair calls with their results.

interface MastraToolCall {
  payload: { toolCallId: string; toolName: string; args?: Record<string, unknown> };
}
interface MastraToolResult {
  payload: { toolCallId: string; result?: unknown };
}

function toRecords(calls: MastraToolCall[], results: MastraToolResult[]): ToolCallRecord[] {
  const byId = new Map<string, ToolCallRecord>();
  for (const c of calls) {
    byId.set(c.payload.toolCallId, { name: c.payload.toolName, args: c.payload.args });
  }
  for (const r of results) {
    const existing = byId.get(r.payload.toolCallId);
    if (existing) existing.result = r.payload.result;
  }
  return [...byId.values()];
}

const calls = (output.toolCalls ?? []) as unknown as MastraToolCall[];
const results = (output.toolResults ?? []) as unknown as MastraToolResult[];
printToolCalls(toRecords(calls, results));
printFinalAnswer(output.text);
