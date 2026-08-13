/* Flax popup — wallet engine + UI */
"use strict";

// ───────────────────────────────────────── helpers
const $ = (id) => document.getElementById(id);
const XRPL_EXPLORER = "https://testnet.xrpl.org/transactions/";
const EVM_EXPLORER = "https://coston2-explorer.flare.network/tx/";
const EVM_ADDR_EXPLORER = "https://coston2-explorer.flare.network/address/";

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 2000);
}

function show(viewId) {
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  $(viewId).classList.add("active");
}

/** "12.5" → 12500000n drops (6 dp), null if invalid */
function parseXrp(str) {
  if (!/^\d+(\.\d{0,6})?$/.test((str || "").trim())) return null;
  const [i, f = ""] = str.trim().split(".");
  return BigInt(i) * 1000000n + BigInt((f + "000000").slice(0, 6));
}
function fmtXrp(drops, maxDec = 6) {
  drops = BigInt(drops);
  const neg = drops < 0n; if (neg) drops = -drops;
  const i = drops / 1000000n, f = (drops % 1000000n).toString().padStart(6, "0");
  let dec = f.slice(0, maxDec).replace(/0+$/, "");
  return (neg ? "-" : "") + i.toLocaleString("en-US") + (dec ? "." + dec : "");
}
/** wei (1e18/XRP) → string with fixed decimals, for the live yield counter */
function fmtXrpWei(wei, dec = 9) {
  wei = BigInt(wei);
  const i = wei / 10n ** 18n;
  const f = (wei % 10n ** 18n).toString().padStart(18, "0").slice(0, dec);
  return i.toString() + "." + f;
}
const short = (s, a = 8, b = 6) => s.length > a + b + 1 ? `${s.slice(0, a)}…${s.slice(-b)}` : s;

function copy(text, label = "Copied") {
  navigator.clipboard.writeText(text).then(() => toast(label));
}

const store = {
  get: (keys) => new Promise((r) => chrome.storage.local.get(keys, r)),
  set: (obj) => new Promise((r) => chrome.storage.local.set(obj, r)),
  clear: () => new Promise((r) => chrome.storage.local.clear(r)),
};

// ───────────────────────────────────────── state
const S = {
  client: null,
  wallet: null,          // xrpl.Wallet
  ledgerDrops: 0n,       // on-ledger balance
  reserveDrops: 1200000n,
  yield: null,           // { principalWei, pendingWei, yieldedDrops, ... }
  activity: [],
  tick: null,            // { baseWei, principalWei, t0 }
  yieldMode: "enable",   // enable | add | withdraw
};

const spendable = () => { const s = S.ledgerDrops - S.reserveDrops - 20n; return s > 0n ? s : 0n; };
const yieldedDrops = () => (S.yield ? S.yield.yieldedDrops : 0n);
const accruedWeiNow = () => {
  if (!S.tick) return 0n;
  const dt = BigInt(Math.floor((Date.now() - S.tick.t0) / 1000));
  return S.tick.baseWei + (S.tick.principalWei * 520n * dt) / (10000n * 31536000n);
};

// ───────────────────────────────────────── xrpl connection
async function connect() {
  if (S.client?.isConnected()) return S.client;
  S.client = new xrpl.Client(FCC.CONFIG.XRPL_WSS);
  await S.client.connect();
  FCC.init(S.client);
  try {
    const si = await S.client.request({ command: "server_info" });
    const v = si.result.info.validated_ledger;
    if (v) S.reserveDrops = BigInt(Math.round((v.reserve_base_xrp + v.reserve_inc_xrp) * 1e6)) + 100000n;
  } catch {}
  return S.client;
}

async function fetchLedgerBalance() {
  try {
    const r = await S.client.request({ command: "account_info", account: S.wallet.address, ledger_index: "validated" });
    S.ledgerDrops = BigInt(r.result.account_data.Balance);
  } catch (e) {
    S.ledgerDrops = 0n; // not activated yet
  }
}

async function refreshYield() {
  try {
    S.yield = await FCC.getYieldState(S.wallet.address);
    S.tick = { baseWei: S.yield.pendingWei, principalWei: S.yield.principalWei, t0: Date.now() };
  } catch (e) {
    console.warn("yield state fetch failed", e);
  }
}

// ───────────────────────────────────────── activity
async function loadActivity() {
  const { flax_activity } = await store.get("flax_activity");
  S.activity = flax_activity || [];
}
async function pushActivity(entry) {
  S.activity.unshift({ ...entry, ts: Date.now() });
  S.activity = S.activity.slice(0, 25);
  await store.set({ flax_activity: S.activity });
}
const ACT_META = {
  recv:      { ico: "↓", cls: "in",  title: "Received" },
  send:      { ico: "↑", cls: "out", title: "Sent" },
  fcc_send:  { ico: "↑", cls: "out", title: "Sent via Flare CC" },
  yield_on:  { ico: "◈", cls: "yld", title: "Yield enabled" },
  yield_add: { ico: "◈", cls: "yld", title: "Added to yield" },
  yield_out: { ico: "◈", cls: "yld", title: "Yield withdrawn" },
  fund:      { ico: "↓", cls: "in",  title: "Wallet activated" },
};
function renderActivity() {
  const list = $("activity-list");
  list.querySelectorAll(".act-item").forEach((n) => n.remove());
  $("activity-empty").style.display = S.activity.length ? "none" : "";
  for (const a of S.activity) {
    const m = ACT_META[a.k] || ACT_META.send;
    const el = document.createElement("a");
    el.className = "act-item";
    if (a.links?.length) { el.href = a.links[0].url; el.target = "_blank"; el.rel = "noopener"; }
    const when = new Date(a.ts).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    const sign = m.cls === "in" ? "+" : m.cls === "out" ? "−" : "";
    el.innerHTML = `
      <span class="act-ico ${m.cls}">${m.ico}</span>
      <span class="act-main"><span class="act-title">${m.title}</span><span class="act-sub">${a.note || when}</span></span>
      <span class="act-amt ${m.cls === "in" ? "in" : ""}">${sign}${fmtXrp(a.amt)} XRP</span>`;
    list.appendChild(el);
  }
}

// ───────────────────────────────────────── home render
function renderHome() {
  const total = S.ledgerDrops + yieldedDrops();
  $("balance-total").innerHTML = `${fmtXrp(total, 6)}<span class="unit">XRP</span>`;
  const hasYield = yieldedDrops() > 0n;
  $("balance-sub").textContent = hasYield
    ? `Available ${fmtXrp(S.ledgerDrops)} · Yielding ${fmtXrp(yieldedDrops())}`
    : `Available ${fmtXrp(S.ledgerDrops)}`;

  $("earn-pill").classList.toggle("hidden", !hasYield);
  $("yield-promo").classList.toggle("hidden", hasYield);
  $("yield-active").classList.toggle("hidden", !hasYield);
  if (hasYield) $("yc-principal").textContent = `${fmtXrp(yieldedDrops())} XRP`;
  renderActivity();
}

// live yield counter
setInterval(() => {
  if (!S.tick || S.tick.principalWei === 0n) return;
  const acc = accruedWeiNow();
  if (!$("yield-active").classList.contains("hidden")) {
    $("yc-earned").textContent = `+${fmtXrpWei(acc, 9)} XRP`;
  }
  if (!$("earn-pill").classList.contains("hidden")) {
    $("earn-pill-text").textContent = `Earning 5.20% APY · +${fmtXrpWei(acc, 8)}`;
  }
}, 300);

// ───────────────────────────────────────── boot
async function boot() {
  const { flax_seed } = await store.get("flax_seed");
  if (!flax_seed) { show("view-onboarding"); return; }
  S.wallet = xrpl.Wallet.fromSeed(flax_seed);
  await loadActivity();
  renderHome();          // paint cached shell immediately
  show("view-home");
  try {
    await connect();
    await Promise.all([fetchLedgerBalance(), refreshYield()]);
    renderHome();
  } catch (e) {
    console.error(e);
    toast("Network error — retrying…");
    setTimeout(boot, 2500);
  }
}

// ───────────────────────────────────────── onboarding
$("btn-create").addEventListener("click", async () => {
  show("view-creating");
  try {
    $("creating-title").textContent = "Creating your wallet…";
    $("creating-sub").textContent = "Generating keys on this device";
    await connect();
    const w = xrpl.Wallet.generate();
    await store.set({ flax_seed: w.seed, flax_address: w.address });
    S.wallet = w;
    $("creating-sub").textContent = "Activating on the XRP Ledger…";
    const funded = await S.client.fundWallet(w);
    S.ledgerDrops = BigInt(xrpl.xrpToDrops(funded.balance));
    await pushActivity({ k: "fund", amt: S.ledgerDrops.toString(), note: "Account activated" });
    await refreshYield();
    renderHome();
    show("view-home");
    toast("Wallet ready");
  } catch (e) {
    console.error(e);
    toast("Creation failed — try again");
    show("view-onboarding");
  }
});

$("btn-goto-import").addEventListener("click", () => show("view-import"));
$("btn-import").addEventListener("click", async () => {
  const seed = $("import-seed").value.trim();
  try {
    const w = xrpl.Wallet.fromSeed(seed);
    await store.set({ flax_seed: seed, flax_address: w.address });
    S.wallet = w;
    show("view-creating");
    $("creating-title").textContent = "Importing…";
    $("creating-sub").textContent = "Syncing with the XRP Ledger";
    await connect();
    await Promise.all([fetchLedgerBalance(), refreshYield(), loadActivity()]);
    renderHome();
    show("view-home");
  } catch (e) {
    toast("Invalid seed");
  }
});

// back buttons
document.querySelectorAll("[data-nav]").forEach((b) =>
  b.addEventListener("click", () => show(b.dataset.nav)));

// ───────────────────────────────────────── receive
$("btn-receive").addEventListener("click", () => {
  $("receive-address").textContent = S.wallet.address;
  show("view-receive");
});
$("btn-copy-address").addEventListener("click", () => copy(S.wallet.address, "Address copied"));

// ───────────────────────────────────────── progress helper
function runSteps(labels) {
  const box = $("progress-steps");
  box.innerHTML = labels.map((l, i) =>
    `<div class="step" id="step-${i}"><span class="bullet"><span class="idx">${i + 1}</span></span><span>${l}</span></div>`).join("");
  show("view-progress");
  return {
    at(i) {
      labels.forEach((_, j) => {
        const el = $(`step-${j}`);
        el.classList.toggle("doing", j === i);
        if (j < i) { el.classList.add("done"); el.querySelector(".bullet").innerHTML = "✓"; }
        else if (j === i) { el.querySelector(".bullet").innerHTML = `<div class="spinner"></div>`; }
      });
    },
    done() {
      labels.forEach((_, j) => {
        const el = $(`step-${j}`);
        el.classList.add("done"); el.classList.remove("doing");
        el.querySelector(".bullet").innerHTML = "✓";
      });
    },
  };
}

function showSuccess(title, sub, links) {
  $("success-title").textContent = title;
  $("success-sub").textContent = sub;
  $("success-links").innerHTML = (links || []).map((l) =>
    `<a href="${l.url}" target="_blank" rel="noopener"><span>${l.label}</span><span class="mono">${short(l.hash, 6, 6)} ↗</span></a>`).join("");
  show("view-success");
}
$("btn-success-done").addEventListener("click", async () => {
  show("view-home");
  await Promise.all([fetchLedgerBalance(), refreshYield()]);
  renderHome();
});

// ───────────────────────────────────────── go
boot();
