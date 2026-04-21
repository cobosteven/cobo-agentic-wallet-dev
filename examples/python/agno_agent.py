"""Agno example using the current pact-first CAW usage model.

Self-contained: read env vars, build the toolkit, run the Agno agent against
the standard CAW demo prompt (submit a pact, perform a compliant transfer,
deliberately trigger a denial, then retry inside the policy cap).
"""

import asyncio
import os

from cobo_agentic_wallet import WalletAPIClient
from cobo_agentic_wallet.integrations.agno import CoboAgentWalletTools

INCLUDE_TOOLS = [
    "submit_pact",
    "get_pact",
    "transfer_tokens",
    "estimate_transfer_fee",
    "get_transaction_record_by_request_id",
    "get_audit_logs",
]


def build_demo_prompt(wallet_id: str, destination: str) -> str:
    return (
        f"Use wallet {wallet_id}. "
        "Submit a pact for a controlled transfer task and wait until it is active. "
        f"Using the newly created pact, transfer 0.001 SETH to {destination} on SETH. "
        "Next, using the same pact, attempt 0.005 SETH. If denied, follow the denial "
        "guidance and retry with a compliant amount. "
        "Track the result by request_id and summarize what happened."
    )


async def main() -> None:
    api_url = os.environ["AGENT_WALLET_API_URL"]
    api_key = os.environ["AGENT_WALLET_API_KEY"]
    wallet_id = os.environ["AGENT_WALLET_WALLET_ID"]
    destination = os.environ.get(
        "CAW_DESTINATION",
        "0x1111111111111111111111111111111111111111",
    )

    async with WalletAPIClient(base_url=api_url, api_key=api_key) as client:
        toolkit = CoboAgentWalletTools(client=client, include_tools=INCLUDE_TOOLS)

        try:
            print("Registered Cobo tools (sync):")
            for name in sorted(toolkit.functions.keys()):
                print(f"  - {name}")
            print("Registered Cobo tools (async):")
            for name in sorted(toolkit.async_functions.keys()):
                print(f"  - {name}")

            if not os.getenv("OPENAI_API_KEY"):
                print("\nSet OPENAI_API_KEY to run a full Agno agent demo prompt.")
                return

            from agno.agent import Agent
            from agno.models.openai import OpenAIChat

            agent = Agent(
                model=OpenAIChat(id="gpt-4.1-mini"),
                tools=[toolkit],
                markdown=True,
            )

            await agent.aprint_response(build_demo_prompt(wallet_id, destination))
        finally:
            await toolkit.aclose()


if __name__ == "__main__":
    asyncio.run(main())
