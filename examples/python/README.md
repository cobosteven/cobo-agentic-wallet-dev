# Python Examples

## Runnable demos

- [`direct_sdk.py`](./direct_sdk.py): canonical pact-first SDK flow (no LLM)
- [`agno_agent.py`](./agno_agent.py): Agno integration with native streaming output
- [`crewai_agent.py`](./crewai_agent.py): CrewAI integration with a single operator agent
- [`langchain_agent.py`](./langchain_agent.py): LangChain v1 integration with a narrow CAW tool surface
- [`openai_agent.py`](./openai_agent.py): OpenAI Agents SDK integration with denial-aware retries

## Shared helpers

The four agent demos share a small [`_shared/`](./_shared) package so each
script can stay focused on framework-specific wiring:

- [`_shared/env.py`](./_shared/env.py): `DemoEnv` dataclass and `DemoEnv.load()` for reading required env vars
- [`_shared/prompt.py`](./_shared/prompt.py): `build_demo_prompt(env)` produces the same transfer-allow-then-deny prompt across frameworks
- [`_shared/tools.py`](./_shared/tools.py): `DEFAULT_INCLUDE_TOOLS` — the canonical pact-first tool surface exposed to the LLM

`direct_sdk.py` does not use `_shared/`; it is a linear tutorial that walks
through the SDK manually.

## Environment

Set these variables before running any example:

```bash
export AGENT_WALLET_API_URL=https://api.agenticwallet.cobo.com
export AGENT_WALLET_API_KEY=your-api-key
export AGENT_WALLET_WALLET_ID=your-wallet-uuid
export CAW_DESTINATION=0x1111111111111111111111111111111111111111  # optional
export OPENAI_API_KEY=sk-...  # required for the four LLM agent demos
```

## Run

```bash
python examples/python/agno_agent.py
python examples/python/crewai_agent.py
python examples/python/langchain_agent.py
python examples/python/openai_agent.py
python examples/python/direct_sdk.py
```
