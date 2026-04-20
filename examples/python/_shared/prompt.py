"""The demo prompt shared across every CAW agent example."""

from __future__ import annotations

from .env import DemoEnv


def build_demo_prompt(env: DemoEnv) -> str:
    """Render the standard "allow then deny, then retry" CAW demo prompt.

    The wording is identical across examples so that comparing output between
    frameworks (Agno, CrewAI, LangChain, OpenAI Agents) is an apples-to-apples
    comparison of how each one handles tool calling and policy denials.
    """
    return (
        f"Use wallet {env.wallet_id}. "
        "Submit a pact for a controlled transfer task and wait until it is active. "
        f"Using the newly created pact, transfer 0.001 SETH to {env.destination} on SETH. "
        "Next, using the same pact, attempt 0.005 SETH. If denied, follow the denial "
        "guidance and retry with a compliant amount. "
        "Track the result by request_id and summarize what happened."
    )
