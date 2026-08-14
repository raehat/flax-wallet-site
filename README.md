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

## Running the extension

1. `cd extension`
2. Open `chrome://extensions`, enable **Developer mode**, click **Load
   unpacked**, select the `extension/` folder.
3. Open the popup, **Create new wallet** — this generates XRPL testnet keys
   client-side and funds the account via the public testnet faucet.
4. **Enable yield** moves XRP into custody, mints FXRP for 70% of it, and
   stakes that into `FlaxYieldVault`. **Send** amounts beyond the liquid
   balance auto-route through the same custody/vault path. Every step links
   to a real Coston2 / XRPL testnet transaction in the activity feed.

No build step — MV3 extensions can't load remote scripts, so `xrpl.js` and
`ethers.js` are vendored locally under `extension/vendor/`.

## Running the TEE extension

`tee-extension/` is deployed independently of the Chrome wallet — it's the
proof that the custody model can run as an attested TEE rather than a plain
signer. Full setup (Docker, ngrok, Coston2 registration, indexer config) is
in `tee-extension/README.md`; short version:

```bash
git clone https://github.com/flare-foundation/fce-sign
cp tee-extension/contracts/InstructionSender.sol   fce-sign/contracts/
cp tee-extension/python/app/{config,handlers}.py    fce-sign/python/app/
cd fce-sign
./scripts/use-chain.sh local coston2 python
./scripts/pre-build.sh      # deploys the contract, registers the extension
./scripts/start-services.sh # builds + runs the TEE + proxy locally
./scripts/post-build.sh     # attests and registers the TEE machine on-chain
```

Once registered, calling `requestAddress()` / `award()` on the deployed
contract dispatches an instruction through Flare's `TeeExtensionRegistry`,
which routes it to the running TEE and posts a signed result back.

## Integration status

- **Contracts** — live on Coston2. `FXRP` and `FlaxYieldVault` run genuine
  mint/stake/unstake logic against real transactions, not mocks.
- **XRPL** — wallet generation, balances, and payments all go through public
  XRPL testnet infrastructure.
- **TEE dispatch** — `tee-extension/` is independently deployed and
  registered on Coston2 (attested, `PRODUCTION` status), and proves the
  custody model end to end: deploy → register → attest → dispatch
  instruction → TEE-signed result.
- **Next integration step**: point the Chrome extension's yield calls at the
  same `InstructionSender → TeeExtensionRegistry → TEE → proxy` dispatch
  path that `tee-extension/` already demonstrates, so the wallet's custody
  operations are TEE-dispatched rather than operator-signed directly. The
  dispatch path itself is proven working in `tee-extension/`; wiring the
  wallet to use it is the remaining integration work.
