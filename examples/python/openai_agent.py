"""OpenAI Agents SDK example using the current pact-first CAW usage model."""

import asyncio
import os

from cobo_agentic_wallet import WalletAPIClient
from cobo_agentic_wallet.integrations.openai import create_cobo_agent, create_cobo_agent_context

from _shared.env import DemoEnv
from _shared.prompt import build_demo_prompt
from _shared.tools import DEFAULT_INCLUDE_TOOLS


async def main() -> None:
    env = DemoEnv.load()

    async with WalletAPIClient(base_url=env.api_url, api_key=env.api_key) as client:
        agent = create_cobo_agent(
            client=client,
            model="gpt-4.1-mini",
            include_tools=DEFAULT_INCLUDE_TOOLS,
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
            result = await Runner.run(agent, build_demo_prompt(env), context=context, max_turns=20)
            print("\nAgent result:", result.final_output)
        finally:
            # Release any pact-scoped aiohttp sessions the toolkit spun up
            # during the run; the owner client is closed by the outer async-with.
            toolkit = getattr(agent, "_caw_toolkit", None)
            if toolkit is not None:
                await toolkit.aclose()


if __name__ == "__main__":
    asyncio.run(main())
