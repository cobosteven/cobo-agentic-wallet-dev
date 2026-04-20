/**
 * LangChain example using the current pact-first CAW usage model.
 *
 * What is specific to LangChain (and therefore stays in this file):
 *   - how a `tool(...)` is declared with a Zod schema,
 *   - how `createAgent(...)` is wired,
 *   - how the returned `result.messages[]` encodes tool calls and results.
 *
 * Everything else (env loading, API client bootstrap, pact spec, session
 * tracking, denial handling, pretty printing) lives in `./lib` and is shared
 * with the OpenAI and Mastra examples.
 */

import { randomUUID } from 'node:crypto';
import { tool, createAgent } from 'langchain';
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

const submitPact = tool(
  async ({ wallet_id, intent }) => {
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
    const response = await ctx.apis.pactsApi.getPact(pact_id);
    ctx.sessions.capture(response.data.result);
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
    const api = ctx.sessions.txApiFor(pact_id);
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
      const api = ctx.sessions.txApiFor(pact_id);
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
        .describe(
          'Pact id from submit_pact / get_pact. REQUIRED to invoke under pact-scoped policy permissions.',
        ),
    }),
  },
);

const getTransactionRecordByRequestId = tool(
  async ({ wallet_uuid, request_id }) => {
    const response = await ctx.apis.recordsApi.getUserTransactionByRequestId(
      wallet_uuid,
      request_id,
    );
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
  async ({ wallet_id, limit }) => listRecentAuditLogs(ctx.apis.auditApi, wallet_id, limit),
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

if (!ctx.env.openaiApiKey) {
  console.log('\nSet OPENAI_API_KEY to run a full agent demo prompt.');
  process.exit(0);
}

const agent = createAgent({
  model: 'openai:gpt-4.1-mini',
  tools,
  systemPrompt: DEMO_SYSTEM_PROMPT,
});

const result = await agent.invoke({
  messages: [{ role: 'user', content: buildDemoPrompt(ctx.env) }],
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
