# Flax contracts

Two contracts, deployed on Flare Coston2, that back the yield side of Flax.

## `FXRP`

A minimal ERC-20 standing in for FAssets FXRP (Flare's 1:1 redeemable
representation of XRP). `mint`/`burn` are restricted to an owner-controlled
allowlist (`minters`) — in production this is the FCC-held operator key; on
this testnet build it's the same key used for the vault interactions.

## `FlaxYieldVault`

Receives FXRP on behalf of Flax users and accrues yield at a fixed test rate
(`RATE_BPS = 520`, i.e. 5.20% APY). Positions are keyed by
`keccak256(bytes(xrplClassicAddress))` rather than an EVM address, since the
depositor of record is an XRPL account, not an EVM one.

- `stakeFor(user, amount)` — pulls FXRP from the caller (the operator) and
  credits `user`'s principal.
- `unstakeFor(user, amount)` — returns principal plus a proportional share of
  accrued yield, minted fresh into the caller's balance.
- `pendingYield(user)` / `principalOf(user)` — read-only, so anyone can verify
  a position without needing operator access.

## Build & deploy

```bash
forge build
forge create src/Flax.sol:FXRP --private-key <key> --rpc-url <coston2-rpc> --broadcast
forge create src/Flax.sol:FlaxYieldVault --private-key <key> --rpc-url <coston2-rpc> \
  --broadcast --constructor-args <fxrp-address>
cast send <fxrp-address> "setMinter(address,bool)" <vault-address> true \
  --private-key <key> --rpc-url <coston2-rpc>
```

## Deployed (Coston2)

| Contract | Address |
|---|---|
| FXRP | `0x2d572a5FB98A029e4ad21860F1E2E7ED8F2c029b` |
| FlaxYieldVault | `0x3d84976Ac03C04F9b7Fcec7af0289776dAECA8a2` |
