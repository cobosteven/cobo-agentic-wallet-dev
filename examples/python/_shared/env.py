"""Environment inputs required to run the CAW agent demos."""

from __future__ import annotations

import os
from dataclasses import dataclass

DEFAULT_DESTINATION = "0x1111111111111111111111111111111111111111"


@dataclass(frozen=True)
class DemoEnv:
    """Credentials and target address every example reads from the environment.

    Load it once at the top of each demo via :meth:`DemoEnv.load` and pass the
    instance around instead of re-reading ``os.environ`` in every helper.
    """

    api_url: str
    api_key: str
    wallet_id: str
    destination: str

    @classmethod
    def load(cls) -> "DemoEnv":
        """Read credentials from the process environment.

        Raises:
            KeyError: if any of ``AGENT_WALLET_API_URL``, ``AGENT_WALLET_API_KEY``
                or ``AGENT_WALLET_WALLET_ID`` is unset.
        """
        return cls(
            api_url=os.environ["AGENT_WALLET_API_URL"],
            api_key=os.environ["AGENT_WALLET_API_KEY"],
            wallet_id=os.environ["AGENT_WALLET_WALLET_ID"],
            destination=os.environ.get("CAW_DESTINATION", DEFAULT_DESTINATION),
        )
