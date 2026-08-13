# Flax — XRP Wallet with Native Yield

A Chrome extension XRP wallet where idle balance earns yield through **Flare
Confidential Compute**, while staying fully spendable.

## How yield works

```
                        ┌─────────────── Flare CC (TEE) ───────────────┐
 Enable yield           │                                              │
 ──────────────►  XRP → │ custody          70% ──► FXRP mint ──► Yield │
                        │ (XRPL)           30% ──► liquid buffer Vault │
                        │                                       5.20%  │
 Spend / withdraw       │                                        APY   │
 ◄──────────────  XRP ← │ buffer pays instantly, then the TEE          │
                        │ rebalances: unstake FXRP → burn → XRP        │
                        └──────────────────────────────────────────────┘
```

- **Enable yield** — XRP moves to FCC custody on XRPL; the TEE attests the
  deposit, mints FXRP 1:1 for 70% of it, and stakes it into the
  `FlaxYieldVault` strategy contract on Flare. 30% stays liquid.
- **Spend while yielding** — if a payment exceeds the wallet's liquid
  balance, Flax routes the shortfall through FCC: custody pays the
  recipient instantly, then the TEE rebalances by unstaking + unwrapping
  the equivalent FXRP. The user never waits on an unstaking period.
- **Withdraw** — custody returns XRP + accrued yield anytime; the position
  unwinds on-chain behind the scenes.

The wallet UI always presents one XRP balance — the yield plumbing is
invisible unless you look at the on-chain receipts (every step links to
XRPL testnet + Coston2 explorers).

## Deployed infrastructure (Coston2 + XRPL testnet)

| Component | Address |
|---|---|
| FXRP token | `0x2d572a5FB98A029e4ad21860F1E2E7ED8F2c029b` |
| FlaxYieldVault | `0x3d84976Ac03C04F9b7Fcec7af0289776dAECA8a2` |
| FCC TEE machine | `0x7592A8CB7FB52aC5C99d80B3Be51374c75B3aa2A` (PRODUCTION) |
| TEE extension ID | `66288` |
| InstructionSender | `0x29057Eb605915003eb7CA918232d75D2cd0e2eA7` |
| FCC custody (XRPL) | `rpsMWxQHqK83RQdiwfAVvKbYVJ5hhtbXWB` |

Vault positions are keyed by `keccak256(xrplAddress)` — inspect
`principalOf` / `pendingYield` on the vault to verify any wallet's position.

## Install

1. Open `chrome://extensions`
2. Toggle **Developer mode** (top right)
3. **Load unpacked** → select this folder (`flax-extension`)
4. Pin Flax, open it, hit **Create new wallet** (auto-funds from the XRPL
   testnet faucet), then **Enable yield**.

## Notes

- Testnet build: enclave operations run locally with the registered TEE
  operator credentials so the full custody → mint → stake → rebalance flow
  executes against real chains. In production these keys exist only inside
  the attested TEE (see Settings → Flare Confidential Compute for the
  attestation identity this build is bound to).
- Contracts source: `../flax-contracts/src/Flax.sol`.
