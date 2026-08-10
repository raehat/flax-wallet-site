"""Handler functions for the XRP wallet extension.

The wallet's private key is generated inside this process the first time it's
needed and is held only in memory — it is never accepted from outside, never
logged, and never included in any ActionResult. In a real (non-simulated) TEE
this means the key only ever exists inside the enclave. Restarting the
container generates a brand-new wallet (and address), since nothing is
persisted outside the enclave's memory.
"""

from __future__ import annotations

import json
import logging
import threading
from typing import Any, Optional

import xrpl
from xrpl.clients import JsonRpcClient
from xrpl.core.addresscodec import is_valid_classic_address
from xrpl.models.requests import AccountInfo
from xrpl.models.transactions import Payment
from xrpl.transaction import sign, submit
from xrpl.wallet import Wallet

from base.types import Framework
from base.encoding import hex_to_bytes, bytes_to_hex
from .config import (
    VERSION,
    OP_TYPE_XRP,
    OP_COMMAND_ADDRESS,
    OP_COMMAND_AWARD,
    XRPL_JSON_RPC_URL,
    AWARD_NUMERATOR,
    AWARD_DENOMINATOR,
    FLAT_FEE_DROPS,
)

logger = logging.getLogger(__name__)

_wallet_lock = threading.Lock()
_wallet: Optional[Wallet] = None


def set_sign_port(port: str) -> None:
    """No-op: main.py (framework infra) always calls this at startup, but this
    extension doesn't call the TEE node's /decrypt endpoint (no externally
    supplied key material), so there's nothing to configure here."""


def _get_or_create_wallet() -> Wallet:
    """Generate the wallet on first use. Generated entirely in-process — no
    external input, no persistence outside memory."""
    global _wallet
    with _wallet_lock:
        if _wallet is None:
            _wallet = Wallet.create()
            logger.info("generated new XRPL testnet wallet: %s", _wallet.address)
        return _wallet


