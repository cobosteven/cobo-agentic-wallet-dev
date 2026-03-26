# Cobo Agentic Wallet

Python and TypeScript SDK surfaces, MCP server, and agent-framework integrations for Cobo Agentic Wallet.

This repo is for developers building AI agents, bots, and automations that:

- move funds
- make payments
- sign messages
- interact with smart contracts
- need scoped authorization instead of raw wallet custody

Instead of giving an agent a private key, Cobo Agentic Wallet gives it a controlled runtime surface:

- pair once with the wallet owner
- submit a pact for a task
- operate within owner-approved boundaries
- receive structured denial feedback when a request is blocked
- keep signing and key management outside the agent runtime

[![PyPI version](https://img.shields.io/pypi/v/cobo-agentic-wallet)](https://pypi.org/project/cobo-agentic-wallet/)
[![Python versions](https://img.shields.io/pypi/pyversions/cobo-agentic-wallet)](https://pypi.org/project/cobo-agentic-wallet/)
[![License](https://img.shields.io/github/license/CoboGlobal/cobo-agentic-wallet-python-sdk)](https://github.com/CoboGlobal/cobo-agentic-wallet-python-sdk/blob/main/LICENSE)

## Related CAW repositories

These repos are expected CAW open-source entry points. Placeholder links are included here until they are published:

- [CAW Python SDK](https://github.com/CoboGlobal/cobo-agentic-wallet-python-sdk)
- [CAW TypeScript SDK](https://github.com/CoboGlobal/cobo-agentic-wallet-typescript-sdk)
- [CAW Golang SDK](https://github.com/CoboGlobal/cobo-agentic-wallet-go-sdk)
- [CAW CLI](https://github.com/CoboGlobal/cobo-agentic-wallet-cli)

## What this repo includes

- **Python SDK** (`WalletAPIClient`) — async client for wallet, pact, and transaction operations
- **TypeScript SDK** (`@cobo/agentic-wallet`) — TypeScript client for wallet, pact, and transaction operations
- **MCP server** — expose wallet tools to any MCP-compatible host
- **Framework integrations** — Python: LangChain, OpenAI Agents SDK, Agno, CrewAI; TypeScript: LangChain, OpenAI Agents SDK, Vercel AI SDK, Mastra; narrow the tool surface with `include_tools` / `exclude_tools`
- **Examples** — runnable SDK and framework integration examples under [`examples/`](examples/)
- **Agent skills** — ready-to-use skill definitions under [`skills/`](skills/)

## Get Started

### 1. Install the `caw` CLI

```bash
curl -fsSL https://raw.githubusercontent.com/CoboGlobal/cobo-agentic-wallet/master/install.sh | bash
```

Then add `caw` to your PATH:

```bash
export PATH="$HOME/.cobo-agentic-wallet/bin:$PATH"
```

Verify the installation:

```bash
caw --version
```

### 2. Onboard and pair with the wallet owner

Run the interactive onboarding wizard. You will need an invitation code from the wallet owner.

```bash
caw onboard --wait --invitation-code <invitation-code>
```

The wizard runs through several phases until wallet `status` becomes `active`.

Once the wallet is active, generate an 8-digit pairing token for the wallet owner:

```bash
caw wallet pair --code-only
```

Wallet owner need download the `Cobo Agentic Wallet` App, then enter the token to complete ownership pairing. Check pairing status with:

```bash
caw wallet pair-status
```

### 3. Claim testnet tokens from the faucet

The example below runs on Sepolia testnet and transfers native `SETH`. Request
it from the built-in faucet:

```bash
# Inspect or generate a Sepolia address for the wallet
caw address list

# Request native Sepolia ETH
caw faucet deposit --token-id SETH --address <your-seth-address>
```

Check the balance with `caw wallet balance`. Once the testnet tokens arrive,
continue with the steps below.

### 4. Get credentials

```bash
caw wallet current --show-api-key
```

Set the output values into the environment variables used below:

```bash
export AGENT_WALLET_API_URL=https://api.agenticwallet.cobo.com
export AGENT_WALLET_API_KEY=your-agent-api-key
export AGENT_WALLET_WALLET_ID=your-wallet-uuid
```

### 5. Install the SDK

**Python:**

```bash
pip install cobo-agentic-wallet
```

**TypeScript:**

```bash
npm install @cobo/agentic-wallet
```

### 6. Submit a pact and run a transfer

**Python:**

```python
import asyncio
import json
import os
import time

from cobo_agentic_wallet.client import WalletAPIClient

CHAIN_ID = "SETH"
TOKEN_ID = "SETH"
DESTINATION = "0x1111111111111111111111111111111111111111"
ALLOWED_AMOUNT = "0.001"
DENIED_AMOUNT = "0.005"
DENY_THRESHOLD = "0.002"


def parse_api_error(exc: Exception) -> dict:
    """Extract the structured error payload from an ApiException body."""
    body = getattr(exc, "body", None)
    if not body:
        return {}
    try:
        payload = json.loads(body)
    except (TypeError, ValueError):
        return {}
    return payload if isinstance(payload, dict) else {}


async def main() -> None:
    api_url = os.environ["AGENT_WALLET_API_URL"]
    api_key = os.environ["AGENT_WALLET_API_KEY"]
    wallet_id = os.environ["AGENT_WALLET_WALLET_ID"]

    client = WalletAPIClient(base_url=api_url, api_key=api_key)

    try:
        # Step 1: Submit a pact requesting transfer permissions for 24 hours.
        print(
            f"[1/6] Submitting pact (allow {CHAIN_ID}/{TOKEN_ID} transfers, "
            f"deny if amount > {DENY_THRESHOLD})..."
        )
        pact_resp = await client.submit_pact(
            wallet_id=wallet_id,
            intent="Transfer tokens for integration testing",
            spec={
                "policies": [
                    {
                        "name": "max-tx-limit",
                        "type": "transfer",
                        "rules": {
                            "effect": "allow",
                            "when": {"chain_in": [CHAIN_ID], "token_in": [{"chain_id": CHAIN_ID, "token_id": TOKEN_ID}]},
                            "deny_if": {"amount_gt": DENY_THRESHOLD},
                        },
                    }
                ],
                "completion_conditions": [
                    {"type": "time_elapsed", "threshold": "86400"}
                ],
            },
        )
        pact_id = pact_resp["pact_id"]
        print(f"      pact submitted: id={pact_id}")

        # Step 2: Poll until the owner approves the pact.
        print("[2/6] Waiting for owner approval in the Cobo Agentic Wallet app...")
        started = time.monotonic()
        last_status = None
        while True:
            pact = await client.get_pact(pact_id)
            status = pact.get("status", "")
            if status != last_status:
                elapsed = int(time.monotonic() - started)
                print(f"      pact status -> {status} (elapsed {elapsed}s)")
                last_status = status
            if status == "active":
                break
            if status in ("rejected", "expired", "revoked", "completed"):
                raise RuntimeError(f"Pact reached terminal status before use: {status}")
            await asyncio.sleep(5)

        # Step 3: Use the pact-scoped API key for all subsequent calls.
        print("[3/6] Pact is active; switching to pact-scoped API key.")
        pact_api_key = pact["api_key"]
        pact_client = WalletAPIClient(base_url=api_url, api_key=pact_api_key)

        try:
            # Step 4: Execute an allowed transfer (within the deny threshold).
            print(f"[4/6] Submitting allowed transfer: {ALLOWED_AMOUNT} {TOKEN_ID} -> {DESTINATION}")
            allowed = await pact_client.transfer_tokens(
                wallet_id,
                chain_id=CHAIN_ID,
                dst_addr=DESTINATION,
                token_id=TOKEN_ID,
                amount=ALLOWED_AMOUNT,
            )
            print(
                f"      ALLOWED: tx_id={allowed.get('id')} "
                f"status={allowed.get('status')} ({allowed.get('status_display') or '-'}) "
                f"request_id={allowed.get('request_id')} "
                f"hash={allowed.get('transaction_hash') or '-'}"
            )

            # Step 5: Trigger a policy denial (amount exceeds the deny threshold).
            print(f"[5/6] Submitting transfer that should be blocked: {DENIED_AMOUNT} {TOKEN_ID} -> {DESTINATION}")
            try:
                await pact_client.transfer_tokens(
                    wallet_id,
                    chain_id=CHAIN_ID,
                    dst_addr=DESTINATION,
                    token_id=TOKEN_ID,
                    amount=DENIED_AMOUNT,
                )
            except Exception as exc:
                payload = parse_api_error(exc)
                err = payload.get("error") or {}
                print(
                    f"      DENIED as expected: http={getattr(exc, 'status', '-')} "
                    f"code={err.get('code', '-')} reason={err.get('reason', '-')}"
                )
                suggestion = payload.get("suggestion")
                if suggestion:
                    print(f"      suggestion: {suggestion}")
        finally:
            await pact_client.close()

        # Step 6: Verify allowed and denied events in audit logs.
        print("[6/6] Fetching recent audit entries for this wallet...")
        logs = await client.list_audit_logs(wallet_id=wallet_id, limit=20)
        items = logs.get("items", []) if isinstance(logs, dict) else []
        allowed_count = sum(1 for item in items if item.get("result") == "allowed")
        denied_count = sum(1 for item in items if item.get("result") == "denied")
        print(f"      audit (last {len(items)} entries): allowed={allowed_count}, denied={denied_count}")

    finally:
        await client.close()


if __name__ == "__main__":
    asyncio.run(main())
```

**TypeScript:**

```typescript
import {
  AuditApi,
  Configuration,
  PactsApi,
  TransactionsApi,
} from '@cobo/agentic-wallet';

const CHAIN_ID = 'SETH';
const TOKEN_ID = 'SETH';
const DESTINATION = '0x1111111111111111111111111111111111111111';
const ALLOWED_AMOUNT = '0.001';
const DENIED_AMOUNT = '0.005';
const DENY_THRESHOLD = '0.002';

interface ApiErrorPayload {
  error?: { code?: string; reason?: string };
  suggestion?: string;
}

function parseApiError(error: unknown): { http: number | string; payload: ApiErrorPayload } {
  const response = (error as { response?: { status?: number; data?: unknown } })?.response;
  const http = response?.status ?? '-';
  const data = response?.data;
  const payload: ApiErrorPayload =
    data && typeof data === 'object' ? (data as ApiErrorPayload) : {};
  return { http, payload };
}

async function main(): Promise<void> {
  const basePath = process.env.AGENT_WALLET_API_URL!;
  const apiKey = process.env.AGENT_WALLET_API_KEY!;
  const walletId = process.env.AGENT_WALLET_WALLET_ID!;

  const ownerConfig = new Configuration({ apiKey, basePath });
  const pactsApi = new PactsApi(ownerConfig);

  console.log(
    `[1/6] Submitting pact (allow ${CHAIN_ID}/${TOKEN_ID} transfers, deny if amount > ${DENY_THRESHOLD})...`,
  );
  const pactResp = await pactsApi.submitPact({
    wallet_id: walletId,
    intent: 'Transfer tokens for integration testing',
    spec: {
      policies: [
        {
          name: 'max-tx-limit',
          type: 'transfer',
          rules: {
            effect: 'allow',
            when: { chain_in: [CHAIN_ID], token_in: [{ chain_id: CHAIN_ID, token_id: TOKEN_ID }] },
            deny_if: { amount_gt: DENY_THRESHOLD },
          },
        },
      ],
      completion_conditions: [
        { type: 'time_elapsed', threshold: '86400' },
      ],
    },
  });

  const pactId = pactResp.data.result.pact_id;
  console.log(`      pact submitted: id=${pactId}`);

  console.log('[2/6] Waiting for owner approval in the Cobo Agentic Wallet app...');
  const started = Date.now();
  let lastStatus: string | undefined;
  let pactApiKey: string | undefined;

  while (true) {
    const pact = (await pactsApi.getPact(pactId)).data.result;
    if (pact.status !== lastStatus) {
      const elapsed = Math.floor((Date.now() - started) / 1000);
      console.log(`      pact status -> ${pact.status} (elapsed ${elapsed}s)`);
      lastStatus = pact.status;
    }

    if (pact.status === 'active') {
      pactApiKey = pact.api_key;
      break;
    }

    if (['rejected', 'expired', 'revoked', 'completed'].includes(pact.status)) {
      throw new Error(`Pact reached terminal status before use: ${pact.status}`);
    }

    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  if (!pactApiKey) {
    throw new Error('Active pact did not return a pact-scoped API key');
  }

  console.log('[3/6] Pact is active; switching to pact-scoped API key.');

  const pactConfig = new Configuration({ apiKey: pactApiKey, basePath });
  const txApi = new TransactionsApi(pactConfig);
  const auditApi = new AuditApi(ownerConfig);

  console.log(`[4/6] Submitting allowed transfer: ${ALLOWED_AMOUNT} ${TOKEN_ID} -> ${DESTINATION}`);
  const allowed = (
    await txApi.transferTokens(walletId, {
      chain_id: CHAIN_ID,
      dst_addr: DESTINATION,
      token_id: TOKEN_ID,
      amount: ALLOWED_AMOUNT,
    })
  ).data.result;
  console.log(
    `      ALLOWED: tx_id=${allowed.id} status=${allowed.status} (${allowed.status_display ?? '-'}) ` +
      `request_id=${allowed.request_id} hash=${allowed.transaction_hash ?? '-'}`,
  );

  console.log(
    `[5/6] Submitting transfer that should be blocked: ${DENIED_AMOUNT} ${TOKEN_ID} -> ${DESTINATION}`,
  );
  try {
    await txApi.transferTokens(walletId, {
      chain_id: CHAIN_ID,
      dst_addr: DESTINATION,
      token_id: TOKEN_ID,
      amount: DENIED_AMOUNT,
    });
  } catch (error) {
    const { http, payload } = parseApiError(error);
    const err = payload.error ?? {};
    console.log(
      `      DENIED as expected: http=${http} code=${err.code ?? '-'} reason=${err.reason ?? '-'}`,
    );
    if (payload.suggestion) {
      console.log(`      suggestion: ${payload.suggestion}`);
    }
  }

  console.log('[6/6] Fetching recent audit entries for this wallet...');
  const logs = await auditApi.listAuditLogs(walletId, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 20);
  const items = logs.data.result.items ?? [];
  const allowedCount = items.filter(item => item.result === 'allowed').length;
  const deniedCount = items.filter(item => item.result === 'denied').length;
  console.log(
    `      audit (last ${items.length} entries): allowed=${allowedCount}, denied=${deniedCount}`,
  );
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
```

### 7. Add MCP or an agent framework

Use a framework only after the direct SDK flow works.

## MCP server

Run the stdio MCP server:

```bash
AGENT_WALLET_API_URL=https://api.agenticwallet.cobo.com \
AGENT_WALLET_API_KEY=your-api-key \
python -m cobo_agentic_wallet.mcp
```

Keep the MCP surface narrow when possible:

```bash
AGENT_WALLET_INCLUDE_TOOLS=submit_pact,get_pact,contract_call,get_transaction_record_by_request_id,get_audit_logs \
python -m cobo_agentic_wallet.mcp
```

Example Claude Desktop config:

```json
{
  "mcpServers": {
    "cobo-agentic-wallet": {
      "command": "python",
      "args": ["-m", "cobo_agentic_wallet.mcp"],
      "env": {
        "AGENT_WALLET_API_URL": "https://api.agenticwallet.cobo.com",
        "AGENT_WALLET_API_KEY": "your-api-key"
      }
    }
  }
}
```

## Framework integrations

Use a framework only after the first direct SDK flow works.

### Python

| Framework | Install | Entry point |
|---|---|---|
| LangChain | `pip install "cobo-agentic-wallet[langchain]"` | `from cobo_agentic_wallet.integrations.langchain import CoboAgentWalletToolkit` |
| OpenAI Agents SDK | `pip install "cobo-agentic-wallet[openai]"` | `from cobo_agentic_wallet.integrations.openai import create_cobo_agent` |
| Agno | `pip install "cobo-agentic-wallet[agno]"` | `from cobo_agentic_wallet.integrations.agno import CoboAgentWalletTools` |
| CrewAI | `pip install "cobo-agentic-wallet[crewai]"` | `from cobo_agentic_wallet.integrations.crewai import CoboAgentWalletCrewAIToolkit` |

### TypeScript

For the TypeScript SDK, see [CAW TypeScript SDK](https://github.com/CoboGlobal/cobo-agentic-wallet-typescript-sdk). The normal pattern is to wrap `@cobo/agentic-wallet` in framework-native tools.

Recommended TypeScript framework paths:

- LangChain
- OpenAI Agents SDK
- Vercel AI SDK
- Mastra

All framework integrations support narrowing the CAW tool surface with `include_tools` and `exclude_tools`.

Recommended presets:

- **Pact Drafting**: `submit_pact`, `get_pact`, `list_pacts`
- **Execution**: `transfer_tokens`, `contract_call`, `estimate_transfer_fee`, `estimate_contract_call_fee`, `get_transaction_record_by_request_id`
- **Observer**: `list_wallets`, `get_wallet`, `get_balance`, `list_transaction_records`, `get_audit_logs`

## Examples

Runnable examples live under [`examples/`](examples/):

**Python:**

- [Direct SDK](examples/python/direct_sdk.py)
- [LangChain](examples/python/langchain_agent.py)
- [OpenAI Agents SDK](examples/python/openai_agent.py)
- [Agno](examples/python/agno_agent.py)
- [CrewAI](examples/python/crewai_agent.py)

**TypeScript:**

- [Direct SDK](examples/typescript/direct_sdk.ts)
- [LangChain](examples/typescript/langchain_agent.ts)
- [OpenAI Agents SDK](examples/typescript/openai_agent.ts)
- [Vercel AI SDK](examples/typescript/vercel_ai_sdk.ts)
- [Mastra](examples/typescript/mastra_agent.ts)

## Skills

Agent skills live under [`skills/`](skills/). These are skill definitions that enable AI agents to operate Cobo Agentic Wallets — covering onboarding, token transfers, DeFi execution, and more.

Install the skill:

```bash
npx skills add CoboGlobal/cobo-agentic-wallet --skill cobo-agentic-wallet --yes --global
```

## Additional references

- release history: [CHANGELOG.md](CHANGELOG.md)
- license: [LICENSE](LICENSE)
