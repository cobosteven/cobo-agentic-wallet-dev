"""CrewAI example using the current pact-first CAW usage model.

Self-contained: read env vars, build the CrewAI toolkit, wire a single-agent
crew, and run it against the standard CAW demo prompt (submit a pact, perform
a compliant transfer, deliberately trigger a denial, then retry inside the
policy cap).
"""

import asyncio
import os

from cobo_agentic_wallet import WalletAPIClient
from cobo_agentic_wallet.integrations.crewai import CoboAgentWalletCrewAIToolkit

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
        toolkit = CoboAgentWalletCrewAIToolkit(
            client=client,
            include_tools=INCLUDE_TOOLS,
        )
        tools = toolkit.get_tools()

        try:
            print("Registered CrewAI tools:")
            for tool in tools:
                print(f"  - {tool.name}: {tool.description[:60]}...")

            if not os.getenv("OPENAI_API_KEY"):
                print("\nSet OPENAI_API_KEY to run a full CrewAI multi-agent crew demo.")
                return

            try:
                from crewai import LLM, Agent, Crew, Process, Task
            except ImportError as exc:
                raise RuntimeError(
                    "crewai is required for this example. Install with: "
                    "pip install 'cobo-agentic-wallet[crewai]'"
                ) from exc

            operator = Agent(
                role="Wallet Operator",
                goal=(
                    "Submit pacts and execute controlled transfers. "
                    "If a transfer is denied by policy, read the denial suggestion "
                    "and retry with compliant parameters."
                ),
                backstory=(
                    "You operate inside CAW guardrails. You submit a pact before execution "
                    "and adapt your next step based on policy feedback. "
                    "If a tool call returns a validation error, read the error message, "
                    "correct the arguments, and call the tool again — do not give up."
                ),
                tools=tools,
                llm=LLM(model="gpt-4.1-mini"),
                verbose=True,
            )

            transfer_task = Task(
                description=build_demo_prompt(wallet_id, destination),
                expected_output=(
                    "A short summary of the allowed transfer, the blocked attempt, and the "
                    "compliant retry."
                ),
                agent=operator,
            )

            crew = Crew(
                agents=[operator],
                tasks=[transfer_task],
                process=Process.sequential,
                verbose=True,
            )

            result = await crew.kickoff_async()
            print("\n--- Crew Result ---")
            print(result)
        finally:
            await toolkit.aclose()


if __name__ == "__main__":
    asyncio.run(main())
