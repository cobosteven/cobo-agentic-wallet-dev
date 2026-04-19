# Python Examples

- [`direct_sdk.py`](./direct_sdk.py): canonical pact-first SDK flow
- [`langchain_agent.py`](./langchain_agent.py): LangChain integration with a narrow CAW tool surface
- [`openai_agent.py`](./openai_agent.py): OpenAI Agents SDK integration with denial-aware retries

Set these environment variables before running examples:

```bash
export AGENT_WALLET_API_URL=https://api.agenticwallet.cobo.com
export AGENT_WALLET_API_KEY=your-api-key
export AGENT_WALLET_WALLET_ID=your-wallet-uuid
export CAW_DESTINATION=0x1111111111111111111111111111111111111111
```
