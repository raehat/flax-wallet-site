# Flax

An XRP wallet (Chrome extension) where idle balance can earn yield without
losing the ability to spend it instantly. Yield is generated off-XRPL by
wrapping a portion of custody into FXRP and deploying it to a staking vault
on Flare, coordinated by a component intended to run inside Flare
Confidential Compute (FCC) — a TEE that can hold a custody key no external
party can read.

Live site: **https://raehat.github.io/flax-wallet-site/**

## Repo layout

```
index.html, css/, img/        marketing site (served by GitHub Pages)
extension/                    the Flax Chrome extension (MV3)
contracts/                    FXRP + FlaxYieldVault Solidity contracts (Coston2)
tee-extension/                XRP custody wallet built as a Flare CC TEE extension
```

Each subfolder has its own README with module-level detail. This one covers
how the pieces fit together and how to run them.

## Architecture

```
                    ┌──────────────── Flare Confidential Compute ───────────────┐
 Flax (Chrome ext)  │                                                           │
 ─────────────────► │  custody (XRPL)      70% → FXRP mint → FlaxYieldVault     │
   XRP deposit       │                      30% → liquid buffer                 │
                     │                                              5.20% APY   │
 spend / withdraw    │                                                          │
 ◄───────────────── │  buffer pays out instantly, then rebalances by            │
                     │  unstaking FXRP → burning back to XRP                    │
                     └───────────────────────────────────────────────────────────┘
```

- **`extension/`** is the user-facing wallet: XRPL key generation, balance,
  send/receive, and the yield UI. It talks to `contracts/` and to XRPL
  testnet directly.
- **`contracts/`** is the on-chain yield side: `FXRP` (wrapped XRP) and
  `FlaxYieldVault` (the staking strategy), both on Coston2.
- **`tee-extension/`** is a separate, standalone Flare CC extension — an XRP
  custody wallet whose private key is generated *inside* a registered TEE and
  never exported. It's built on Flare's own `fce-sign` scaffold and
  demonstrates the attestation/registration path this architecture depends
  on end to end (deploy → register → attest → dispatch instructions →
  TEE-signed result).

