"""LangChain example using the current pact-first CAW usage model."""

import asyncio
import json
import os
from typing import Any

from cobo_agentic_wallet import WalletAPIClient
from cobo_agentic_wallet.integrations.langchain import CoboAgentWalletToolkit


def _truncate(value: Any, limit: int = 120) -> str:
    text = value if isinstance(value, str) else json.dumps(value, default=str)
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _format_tool_args(args: dict[str, Any]) -> str:
    skip = {"wallet_uuid", "wallet_id"}
    return ", ".join(f"{k}={_truncate(v, 60)}" for k, v in args.items() if k not in skip) or "-"


def _summarise_tool_result(raw: Any) -> str:
    if isinstance(raw, str):
        try:
            payload = json.loads(raw)
        except (TypeError, ValueError):
            return _truncate(raw.replace("\n", " "))
    else:
        payload = raw
    if not isinstance(payload, dict):
        return _truncate(payload)
    # Pact submission result.
    if "pact_id" in payload and "status" in payload and "request_id" not in payload:
        return f"pact_id={_truncate(payload['pact_id'], 36)} status={payload.get('status')}"
    # Transfer submission result.
    if "request_id" in payload:
        bits = [f"request_id={_truncate(payload['request_id'], 36)}"]
        if payload.get("status_display"):
            bits.append(f"status={payload['status_display']}")
        elif "status" in payload:
            bits.append(f"status={payload['status']}")
        if payload.get("transaction_hash"):
            bits.append(f"hash={payload['transaction_hash']}")
        return " ".join(bits)
    # Structured API error envelope.
    if "error" in payload:
        err = payload["error"]
        if isinstance(err, dict):
            return f"ERROR {err.get('code', '-')}: {err.get('reason', '-')}"
        return f"ERROR {err}"
    return _truncate(payload)


def print_agent_result(result: Any) -> None:
    messages = result.get("messages", []) if isinstance(result, dict) else []
    tool_calls_by_id: dict[str, dict[str, Any]] = {}
    final_text = ""
    for msg in messages:
        tcs = getattr(msg, "tool_calls", None) or []
        for tc in tcs:
            tool_calls_by_id[tc["id"]] = {"name": tc["name"], "args": tc.get("args", {})}
        tc_id = getattr(msg, "tool_call_id", None)
        if tc_id and tc_id in tool_calls_by_id:
            tool_calls_by_id[tc_id]["result"] = getattr(msg, "content", "")
        content = getattr(msg, "content", "")
        if content and not tcs and not tc_id:
            final_text = content

    print("\nTool calls:")
    if not tool_calls_by_id:
        print("  (none)")
    for idx, call in enumerate(tool_calls_by_id.values(), start=1):
        args = _format_tool_args(call.get("args", {}))
        result_summary = _summarise_tool_result(call.get("result", ""))
        print(f"  {idx}. {call['name']}({args})")
        print(f"     → {result_summary}")

    print("\nFinal answer:")
    print(final_text or "(no final answer produced)")


async def main() -> None:
    api_url = os.environ["AGENT_WALLET_API_URL"]
    api_key = os.environ["AGENT_WALLET_API_KEY"]
    wallet_uuid = os.environ["AGENT_WALLET_WALLET_ID"]
    destination = os.environ.get(
        "CAW_DESTINATION",
        "0x1111111111111111111111111111111111111111",
    )

    async with WalletAPIClient(base_url=api_url, api_key=api_key) as client:
        toolkit = CoboAgentWalletToolkit(
            client=client,
            include_tools=[
                "submit_pact",
                "get_pact",
                "transfer_tokens",
                "estimate_transfer_fee",
                "get_transaction_record_by_request_id",
                "get_audit_logs",
            ],
        )
        tools = toolkit.get_tools()

        try:
            print("Registered Cobo LangChain tools:")
            for tool in tools:
                print(f"  - {tool.name}: {tool.description}")

            if not os.getenv("OPENAI_API_KEY"):
                print(
                    "\nSet OPENAI_API_KEY and install langchain-openai "
                    "to run a full agent demo prompt."
                )
                return

            try:
                from langchain_openai import ChatOpenAI
            except ImportError as exc:
                raise RuntimeError(
                    "langchain-openai is required for the OpenAI model example. "
                    "Install with: pip install langchain-openai"
                ) from exc

            prompt = (
                f"Use wallet {wallet_uuid}. "
                "Submit a pact for a controlled transfer task and wait until it is active. "
                f"Using the newly created pact, transfer 0.001 SETH to {destination} on SETH. "
                "Next, using the same pact, attempt 0.005 SETH. If denied, follow the denial "
                "guidance and retry with a compliant amount. "
                "Track the result by request_id and summarize what happened."
            )

            # LangChain v1 API
            try:
                from langchain.agents import create_agent
            except ImportError:
                create_agent = None

            if create_agent is not None:
                agent = create_agent(
                    model=ChatOpenAI(model="gpt-4.1-mini"),
                    tools=tools,
                )
                result = await agent.ainvoke(
                    {"messages": [{"role": "user", "content": prompt}]}
                )
                print_agent_result(result)
                return

            # Legacy pre-v1 API fallback
            try:
                from langchain.agents import AgentExecutor, create_openai_tools_agent
                from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
            except ImportError as exc:
                raise RuntimeError(
                    "Unsupported langchain version detected. Install langchain>=1.0.0, "
                    "or a compatible legacy release exposing create_openai_tools_agent."
                ) from exc

            llm = ChatOpenAI(model="gpt-4.1-mini", temperature=0)
            prompt_template = ChatPromptTemplate.from_messages(
                [
                    ("human", "{input}"),
                    MessagesPlaceholder(variable_name="agent_scratchpad"),
                ]
            )
            agent = create_openai_tools_agent(llm, tools, prompt_template)
            executor = AgentExecutor(agent=agent, tools=tools, verbose=True)
            result = await executor.ainvoke({"input": prompt})
            print("\nFinal answer:")
            print(result.get("output", result))
        finally:
            await toolkit.aclose()


if __name__ == "__main__":
    asyncio.run(main())
