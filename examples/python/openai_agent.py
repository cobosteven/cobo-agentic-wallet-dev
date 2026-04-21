"""OpenAI Agents SDK example using the current pact-first CAW usage model.

Self-contained: read env vars, build the OpenAI Agents tool set, and run the
agent against the standard CAW demo prompt (submit a pact, perform a
compliant transfer, deliberately trigger a denial, then retry inside the
policy cap).
"""

import asyncio
import os

from cobo_agentic_wallet import WalletAPIClient
from cobo_agentic_wallet.integrations.openai import create_cobo_agent, create_cobo_agent_context

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
        agent = create_cobo_agent(
            client=client,
            model="gpt-4.1-mini",
            include_tools=INCLUDE_TOOLS,
        )
        try:
            print("Registered Cobo OpenAI tools:")
            for tool in agent.tools:
                name = getattr(tool, "name", tool.__class__.__name__)
                description = getattr(tool, "description", "")
                print(f"  - {name}: {description}")

            if not os.getenv("OPENAI_API_KEY"):
                print("\nSet OPENAI_API_KEY to run a full OpenAI agent demo prompt.")
                return

            try:
                from agents import Runner
            except ImportError as exc:
                raise RuntimeError(
                    "openai-agents is required for this example. "
                    "Install with: pip install 'cobo-agentic-wallet[openai]'"
                ) from exc

            context = create_cobo_agent_context()
            result = await Runner.run(
                agent,
                build_demo_prompt(wallet_id, destination),
                context=context,
                max_turns=20,
            )
            print("\nAgent result:", result.final_output)
        finally:
            # Release any pact-scoped aiohttp sessions the toolkit spun up
            # during the run; the owner client is closed by the outer async-with.
            toolkit = getattr(agent, "_caw_toolkit", None)
            if toolkit is not None:
                await toolkit.aclose()


if __name__ == "__main__":
    asyncio.run(main())
