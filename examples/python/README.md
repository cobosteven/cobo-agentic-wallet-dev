# Python Examples

## Runnable demos

- [`direct_sdk.py`](./direct_sdk.py): canonical pact-first SDK flow (no LLM)
- [`agno_agent.py`](./agno_agent.py): Agno integration with native streaming output
- [`crewai_agent.py`](./crewai_agent.py): CrewAI integration with a single operator agent
- [`langchain_agent.py`](./langchain_agent.py): LangChain v1 integration with a narrow CAW tool surface
- [`openai_agent.py`](./openai_agent.py): OpenAI Agents SDK integration with denial-aware retries

Every script is self-contained — copy a single file and it runs once the
environment variables below are set. The four agent demos share the same
demo prompt, included tool surface, and env-var names by convention so their
traces are directly comparable across frameworks.

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
