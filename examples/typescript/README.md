# TypeScript Examples

Runnable TypeScript examples for the Cobo Agentic Wallet (CAW), demonstrating
the pact-first usage model across four entry points.

## Examples

- [`direct_sdk.ts`](./direct_sdk.ts) — canonical SDK flow without any agent
  framework. Best starting point for understanding the pact lifecycle.
- [`langchain_agent.ts`](./langchain_agent.ts) — LangChain `tool(...)` wrappers
  and `createAgent(...)` wiring over `@cobo/agentic-wallet`.
- [`openai_agent.ts`](./openai_agent.ts) — OpenAI Agents SDK (`@openai/agents`)
  integration with strict-schema compatible tools.
- [`mastra_agent.ts`](./mastra_agent.ts) — Mastra (`@mastra/core`) integration
  using `createTool({...})` and `agent.generate(...)`.

Each agent example is deliberately structured as a short, top-to-bottom script
so that the framework-specific parts (how tools are declared, how the agent is
wired, and how tool-call traces are shaped) remain obvious at a glance.

## Shared infrastructure (`./lib`)

Plumbing that is identical across frameworks is factored into a small library
so each example focuses on what is unique to its framework:

| File | Responsibility |
| --- | --- |
| [`lib/env.ts`](./lib/env.ts) | Environment-variable loader with fail-fast validation. |
| [`lib/clients.ts`](./lib/clients.ts) | Factories for owner-scoped and pact-scoped API clients; named-parameter wrapper for `listAuditLogs`. |
| [`lib/pact-spec.ts`](./lib/pact-spec.ts) | Single source of truth for the demo policy — chain / token / amounts / `buildTransferPactSpec`. |
| [`lib/pact-session.ts`](./lib/pact-session.ts) | `PactSessionStore`: maps `pact_id → api_key`, caches per-pact `TransactionsApi` instances. |
| [`lib/errors.ts`](./lib/errors.ts) | `parseApiError` + `returnPolicyDenial` — turn service errors into a `DenialEnvelope` the LLM can act on. |
| [`lib/prompt.ts`](./lib/prompt.ts) | Shared system prompt and demo user prompt so all agents solve the same task. |
| [`lib/printer.ts`](./lib/printer.ts) | Framework-agnostic pretty-printer: `ToolCallRecord[]` → numbered trace + final answer. |
| [`lib/context.ts`](./lib/context.ts) | `DemoContext.load()` bundles env + API clients + session store into one import. |

## Setup

```bash
npm install
```

## Running

Environment variables required by every example:

```bash
export AGENT_WALLET_API_URL=https://api.agenticwallet.cobo.com
export AGENT_WALLET_API_KEY=your-api-key
export AGENT_WALLET_WALLET_ID=your-wallet-uuid
export CAW_DESTINATION=0x1111111111111111111111111111111111111111  # optional
```

Agent examples additionally require an OpenAI key:

```bash
export OPENAI_API_KEY=sk-...
```

Run any example:

```bash
npm run direct       # direct_sdk.ts
npm run langchain    # langchain_agent.ts
npm run openai       # openai_agent.ts
npm run mastra       # mastra_agent.ts
```

Type-check all files without emitting:

```bash
npm run typecheck
```
