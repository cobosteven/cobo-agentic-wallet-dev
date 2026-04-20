"""CrewAI example using the current pact-first CAW usage model."""

import asyncio
import os

from cobo_agentic_wallet import WalletAPIClient
from cobo_agentic_wallet.integrations.crewai import CoboAgentWalletCrewAIToolkit

from _shared.env import DemoEnv
from _shared.prompt import build_demo_prompt
from _shared.tools import DEFAULT_INCLUDE_TOOLS


async def main() -> None:
    env = DemoEnv.load()

    async with WalletAPIClient(base_url=env.api_url, api_key=env.api_key) as client:
        toolkit = CoboAgentWalletCrewAIToolkit(
            client=client,
            include_tools=DEFAULT_INCLUDE_TOOLS,
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
                description=build_demo_prompt(env),
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
