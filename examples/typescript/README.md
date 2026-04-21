# TypeScript Examples

Runnable TypeScript examples for the Cobo Agentic Wallet (CAW), demonstrating
the pact-first usage model across five entry points.

## Examples

- [`direct_sdk.ts`](./direct_sdk.ts) — canonical SDK flow without any agent
  framework. Best starting point for understanding the pact lifecycle.
- [`langchain_agent.ts`](./langchain_agent.ts) — LangChain `tool(...)` wrappers
  and `createAgent(...)` wiring over `@cobo/agentic-wallet`.
- [`openai_agent.ts`](./openai_agent.ts) — OpenAI Agents SDK (`@openai/agents`)
  integration with strict-schema compatible tools.
- [`mastra_agent.ts`](./mastra_agent.ts) — Mastra (`@mastra/core`) integration
  using `createTool({...})` and `agent.generate(...)`.
- [`vercel_ai_sdk.ts`](./vercel_ai_sdk.ts) — Vercel AI SDK (`ai` v5)
  integration using `tool({...})` and `generateText({...})`.

Every file is **self-contained** — copy a single script into a fresh project,
install the packages listed in `package.json`, set the environment variables
below, and it runs. Each agent example is organised top-to-bottom into
labelled sections (`// ─── Env ───`, `// ─── Pact session store ───`, `// ─── Tool definitions ───`, …)
so the framework-specific parts stay easy to scan without having to chase
imports across a shared library.

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
npm run vercel       # vercel_ai_sdk.ts
```

Type-check all files without emitting:

```bash
npm run typecheck
```
