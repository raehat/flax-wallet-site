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


def register(framework: Framework) -> None:
    """Register the XRP handlers with the framework."""
    framework.handle(OP_TYPE_XRP, OP_COMMAND_ADDRESS, handle_get_address)
    framework.handle(OP_TYPE_XRP, OP_COMMAND_AWARD, handle_award)


def report_state() -> Any:
    """Return a JSON-serializable snapshot of the current state (for local /state debugging)."""
    wallet = _get_or_create_wallet()
    return {
        "address": wallet.address,
        "version": VERSION,
    }


def _get_or_create_wallet() -> Wallet:
    """Generate the wallet on first use. Generated entirely in-process — no
    external input, no persistence outside memory."""
    global _wallet
    with _wallet_lock:
        if _wallet is None:
            _wallet = Wallet.create()
            logger.info("generated new XRPL testnet wallet: %s", _wallet.address)
        return _wallet


def handle_get_address(msg: str) -> tuple[Optional[str], int, Optional[str]]:
    """Report the wallet's XRP testnet address so people know where to send test XRP."""
    wallet = _get_or_create_wallet()
    data_hex = bytes_to_hex(wallet.address.encode("ascii"))
    return data_hex, 1, None


def handle_award(msg: str) -> tuple[Optional[str], int, Optional[str]]:
    """Pay out AWARD_NUMERATOR/AWARD_DENOMINATOR (10%) of the wallet's current
    XRP testnet balance to the address supplied in the instruction."""
    wallet = _get_or_create_wallet()

    if not msg:
        return None, 0, "originalMessage is empty"

    try:
        target = hex_to_bytes(msg).decode("ascii").strip()
    except Exception as e:
        return None, 0, f"invalid address payload: {e}"

    if not target or not is_valid_classic_address(target):
        return None, 0, f"not a valid XRPL classic address: {target!r}"

    client = JsonRpcClient(XRPL_JSON_RPC_URL)

    try:
        info = client.request(AccountInfo(account=wallet.address, ledger_index="validated"))
    except Exception as e:
        return None, 0, f"failed to query wallet balance: {e}"

    if not info.is_successful() or "account_data" not in info.result:
        return None, 0, (
            f"wallet {wallet.address} not found on XRPL testnet yet — "
            "fund it with test XRP first"
        )

    balance_drops = int(info.result["account_data"]["Balance"])
    award_drops = (balance_drops * AWARD_NUMERATOR) // AWARD_DENOMINATOR

    if award_drops <= 0:
        return None, 0, f"balance too low to award: {balance_drops} drops"

    # Built with sequence/fee already in hand (from the AccountInfo call
    # above) instead of calling autofill(), which would redundantly re-fetch
    # account_info plus a fee lookup. The TEE router only waits so long for
    # this handler to respond, so every extra XRPL round-trip risks the
    # result never making it back through the proxy even though the payment
    # itself would still go through. FLAT_FEE_DROPS overpays the ~10 drop
    # network minimum, which is fine on testnet and avoids a fee query.
    payment = Payment(
        account=wallet.address,
        amount=str(award_drops),
        destination=target,
        sequence=int(info.result["account_data"]["Sequence"]),
        fee=FLAT_FEE_DROPS,
    )

    try:
        signed = sign(payment, wallet)
        tx_hash = signed.get_hash()
        response = submit(signed, client)
    except Exception as e:
        return None, 0, f"XRPL payment failed: {e}"

    engine_result = response.result.get("engine_result", "")
    if not engine_result.startswith("tes"):
        return None, 0, f"XRPL submission rejected: {engine_result or 'unknown'}"

    payload = json.dumps({
        "txHash": tx_hash,
        "amountDrops": award_drops,
        "destination": target,
    })
    return bytes_to_hex(payload.encode("utf-8")), 1, None
