"""Agno example using the current pact-first CAW usage model."""

import asyncio
import os

from cobo_agentic_wallet import WalletAPIClient
from cobo_agentic_wallet.integrations.agno import CoboAgentWalletTools

from _shared.env import DemoEnv
from _shared.prompt import build_demo_prompt
from _shared.tools import DEFAULT_INCLUDE_TOOLS


async def main() -> None:
    env = DemoEnv.load()

    async with WalletAPIClient(base_url=env.api_url, api_key=env.api_key) as client:
        toolkit = CoboAgentWalletTools(client=client, include_tools=DEFAULT_INCLUDE_TOOLS)

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

            await agent.aprint_response(build_demo_prompt(env))
        finally:
            await toolkit.aclose()


if __name__ == "__main__":
    asyncio.run(main())
