"""The default surface of CAW tools exposed to LLM agents in the demos.

The list is intentionally narrow: it covers the pact-first transfer flow
(submit -> poll -> transfer -> audit) and nothing else. Examples can still
override it if they want to demonstrate a different scenario.
"""

from __future__ import annotations

DEFAULT_INCLUDE_TOOLS: list[str] = [
    "submit_pact",
    "get_pact",
    "transfer_tokens",
    "estimate_transfer_fee",
    "get_transaction_record_by_request_id",
    "get_audit_logs",
]
