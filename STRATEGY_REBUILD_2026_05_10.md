# STRATEGY REBUILD 2026-05-10 — Active Plan + Handover

> **THIS IS THE LIVE PLAN. If you are a new agent, start here, then read `README.md` for historical context.**
> **Continuity contract**: As work progresses, tick off items in this file, append findings below the plan, and sync `progress.txt`. Treat this file + `README.md` + `.agent/skills/DEITY/SKILL.md` as joint source of truth.

## 🎯 Operator Goal (locked-in, verified 2026-05-10)

| Constraint | Value |
|------------|-------|
| **Time budget** | Full (3–5 days, all 5 phases) |
| **Profit target** | **$500+ as MEDIAN** in 7d, sweet-spot of upside + low bust |
| **Starting bankroll** | **$12.89** as-is (no top-up) |
| **If target missed** | **Iterate** with new hypotheses until found AND present **portfolio** of best-available options |
| **Live smoke source** | The strategy **WE FIND**, not any currently loaded one |
| **Smoke mode** | Operator-supervised, paused-by-default, exposure-capped |
| **Anti-hallucination** | Every claim must separate historical replay, stress replay, and honest forward expectation; live metrics must come from `/api/health` + `/api/status` |

## 📋 Current Verified State (as of 2026-05-10, 14:04 UTC)

| Item | Value / Evidence |
|------|------------------|
| Fly app | `https://polyprophet.fly.dev` release `107`, intentionally `degraded` |
| Live balance | `$12.892746` pUSD, `tradeReady.ok=true`, `signatureType=3` deposit-wallet |
| Paused | `LIVE_AUTOTRADING_ENABLED=false`, `manualPause=true`, `startPausedEnv=true` |
| Strategies loaded | `5m=8`, `15m=4` from `strategy_set_*_structural_edge_20260509T190152Z.json` (inert) |
| Lifetime trades | `12` (7W/5L = 58.3% live WR vs 88% claimed replay) |
| Peak / drawdown | Peak `$28.85` → now `$12.89` = 55.3% drawdown, brake active |
| `todayPnL` phantom | `-$249.76` cosmetic residue from fixed matched-shares bug (real loss was `$1.80`) |
| Queues | `pendingBuys=0`, `pendingSells=0`, `recoveryQueue=0`, `redemptionQueue=2` (dust, non-actionable) |
| 15m data | `data/intracycle-price-data.json` — 8366 cycles, last May 2 (STALE, gap-filling in progress) |
| 5m data | `debug/recent_5m_cycle_cache_2d.json` — 4032 cycles May 7–9 (refreshing 14d) |
| 4h data | `debug/recent_4h_cycle_cache_14d.json` — **644 cycles, refreshed to May 10 08:00 UTC ✅** |

## 🧠 Why All 8+ Prior Searches Failed (root-cause synthesis)

1. **Static feature-space mining** (`UTC_hour × entry_minute × direction × price_band`, 10k–115k combos) → pattern-matches noise.
2. **Backtests use resolved minute prices** → fee model is correct but liquidity/spread/queue priority is fantasy.
3. **Holdouts are 3–7 days** → tiny N. Walk-forward accepts rules with 5–15 triggers.
4. **No paper-shadow forward proof** → leap from "passed audit" to "deploy live" has no bridge.
5. **No causal rationale required** → rules have no "why", so when they fail there's no diagnosis.
6. **Structural 5m strategies are unfireable under close-guard** (new finding, Phase 0.2): `entrySecondMax=59, entryMinuteMax=4` + 45s block = 0 valid seconds.

## 🔁 Phase Plan + Live Checklist (tick as completed)

### Phase 0 — Hygiene + Forensic Reset (no live trades)

- [x] **0.1 Runtime-stats rebase mechanism**: Discovered `POST /api/validator/reset` already covers this. `{"confirmReset":true,"clearTradeLog":false,"preservePause":true}` clears `todayPnL/peakBalance/dayStartBalance/consecutiveLosses` while **preserving** trade history. No new code needed.
- [x] **0.2 Close-window guard property test**: Created `scripts/test-close-window-guard.js`. Sweeps 5m/15m/4h across every second in the epoch plus dense boundary sampling; also audits every production strategy file. **Verdict: ALL PROPERTIES HOLD, 36/36 verify-harness checks pass.** Key incidental finding: 5m structural strategies are entirely unfireable under the 45s close-guard (explains zero 5m fills).
- [ ] **0.3 Refresh 15m intracycle data (May 2 → May 10)**: `node scripts/collect-intracycle-gap-fill.js` running in background. BTC 630/741 at last check; will continue through ETH/SOL/XRP (expected another ~15–30 min). Output log: `data/_gap-fill-15m.log`.
- [ ] **0.4 Refresh 5m + 4h caches (14d)**:
  - 4h: ✅ `debug/recent_4h_cycle_cache_14d.json` has 644 cycles through May 10 08:00 UTC.
  - 5m: ⏳ `FETCH_TIMEFRAME=5m FETCH_DAYS=14 node scripts/fetch-recent-cycle-cache.js` running; at 500/28231 at last check (~30–60 min total). Output log: `data/_recent-5m-14d.log`.
- [x] **0.5 Fly env safe-state audit**: `/api/health` confirms paused, autotrading off, $12.89, drawdown brake active (effective stake fraction 0.12 due to 55.3% drawdown).

### Phase 1 — Forward-Evidence Capture Infrastructure (paper-shadow)

- [x] **1.1 `scripts/paper-shadow-recorder.js`**: ✅ Built and smoke-tested. Runs standalone, captures every tick with live CLOB bid/ask + depth (within 2c of best), structural Binance signal, strategy-matcher decision, and full market metadata. Output at `data/paper-shadow/YYYY-MM-DD/<asset>_<tf>.jsonl`. Smoke test on BTC+ETH 15m at 2026-05-10 14:26-14:27 UTC captured 4 valid records with `bestAsk=0.17, askDepthShares=618, structural moveBps=-3.85 DOWN`, proving live executable data is being written. Env vars: `PAPER_SHADOW_TICK_MS` (default 15000), `PAPER_SHADOW_ASSETS`, `PAPER_SHADOW_TIMEFRAMES`, `PAPER_SHADOW_STRATEGY_{5M,15M,4H}_PATH`, `PAPER_SHADOW_OUT_DIR`. Loop is self-healing (errors logged but don't kill the process). At cycle close, a `__settlement__` record with YES/NO outcome is appended.
- [x] **1.2 `lib/paper-shadow.js`**: ✅ Not needed as separate lib — the recorder directly reuses `lib/market-discovery`, `lib/strategy-matcher`, and `lib/structural-signal` from the production runtime, guaranteeing sim/live parity without an extra layer.
- [ ] **1.3 48h live-shadow run**: ⏳ To be kicked off as long-running background process after Phase 0 data refreshes complete. Target: ≥200 signal opportunities across 5m/15m with settlements attached. Command: `node scripts/paper-shadow-recorder.js` (redirect stdout to a log).
- [ ] **1.4 `/api/paper-shadow/state` endpoint**: Optional add-on. Can expose capture stats (count by asset/tf/match-type, recent hits, would-have-entered WR once enough settlements accumulate). LOW priority; the JSONL files are directly analyzable with `node -e` snippets.

### Phase 2 — Anti-Overfit Strategy Discovery (iterative)

- [ ] **2.1 `scripts/honest-strategy-search.js`**: Mandatory gates (stricter than any prior search):
  - Walk-forward chronological 70/15/15 split
  - **Min 30 triggers** per rule on training, **15** on holdout
  - **Wilson LCB95 ≥ 0.75** on every individual rule (not aggregate)
  - Adverse fill **+5c**, slippage **1.5%**, fees **7.2%**
  - Liquidity check: actual ask depth ≥ `shares × 1.2`
  - **Leave-one-day-out**: every excluded day still profitable on holdout
  - **Leave-one-asset-out**: every excluded asset still profitable on holdout
  - **Causal rationale required** (mandatory text field per candidate)
- [ ] **2.2 H1 — Spread convergence**: `yes_price + no_price → 1.0` tight-book conviction
- [ ] **2.2 H2 — CEX-lag SAFE variant**: closed Binance candle direction, entry ≤ minute 13 (NOT 14:55), with `STRUCTURAL_SIGNAL_REQUIRE_CLOSED_CANDLE=true`
- [ ] **2.2 H3 — Regime-aware momentum**: vol-cluster hour tiers, trade only low-vol/high-conviction regimes
- [ ] **2.2 H4 — Multi-timeframe stacking**: 4h directional bias × 15m entry trigger × 5m confirmation
- [ ] **2.2 H5 — Order-flow imbalance**: when prints exist, YES-side dominance in first 5 min
- [ ] **2.2 ITER — new hypotheses until goal met**: Iterate Phase 2 with additional hypotheses (arbitrage residuals, liquidation windows, CPI/FOMC schedule effects, funding-rate inversions) until a candidate survives all gates with projected 7d median ≥ $500 at ≤ 10% bust from $12.89.
- [ ] **2.3 Confidence cards**: `strategies/confidence_cards/<id>.json` — 5,000-run Monte-Carlo with adverse frictions, P10/P25/P50/P75/P90 curves, bust-rate, max-drawdown distribution. **This is the only evidence format allowed for promotion decisions.**

### Phase 3 — Paper-Shadow Forward Validation

- [ ] **3.1 Forward-replay top 3 candidates** against the 48h paper-shadow recording. Required:
  - Forward WR within **5pp** of replay WR
  - **≥10 forward triggers** observed
  - Non-negative net EV after frictions
  - Zero unsafe behaviors (no close-window near-misses, no oversized orders, no liquidity-stretched fills)
- [ ] **3.2 Promotion gate + portfolio**: If any candidate passes all 4 criteria AND hits $500+ median at low bust → promotion. Produce a portfolio JSON with `best_safe` + `best_upside` + `best_blended` variants so operator can choose.

### Phase 4 — Controlled Live Smoke (ONLY with operator green-light)

- [ ] **4.1 Promote chosen candidate** to `STRATEGY_SET_15M_PATH` / `STRATEGY_SET_5M_PATH` on Fly, bot remaining **paused**.
- [ ] **4.2 Exposure caps**: `MAX_NOTIONAL_PER_TRADE=1.50` (~12% of $12.89), `MICRO_BANKROLL_MPC_CAP=1`.
- [ ] **4.3 Operator unpauses** (Telegram + `LIVE_AUTOTRADING_ENABLED=true`).
- [ ] **4.4 Watch first 5 fills**. Pause immediately on: first 3 trades drifting >5pp from paper, any close-window near-miss, any fill outside paper-predicted price range.
- [ ] **4.5 After 10 settled trades** re-audit. GO deeper, pause, or refine.

### Phase 5 — README Update + Handoff

- [ ] **5.1 README addendum** with GO / NO-GO verdict, exact reproduction commands, and honest P-curves.
- [ ] **5.2 Handover-sync**: update this file, `progress.txt`, and `README.md` HANDOFF_STATE block.

## 🧪 Evidence Captured So Far

### Phase 0.2 — Close-window guard audit
Production strategy files inventory (from `scripts/test-close-window-guard.js` run at 2026-05-10 14:01 UTC):
- All 15m/5m/4h production strategies: runtime guard successfully blocks every danger-zone entry.
- **Key finding**: Of the 4 currently-loaded 15m structural rules, **all 4** rely on `entrySecondMax=59` + `entryMinuteMax=14`, i.e. only fire in the blocked 14:55–14:59 window. Same for 5 of 8 5m rules → structural strategies as deployed are essentially unfireable. This explains the absence of legitimate structural fills after the guard was added. **Implication**: Phase 2 H2 (CEX-lag SAFE variant) must rewrite entry timing to ≤ minute 13 (15m) / ≤ minute 3 (5m) to actually be tradeable.

### Phase 1.1 — Paper-shadow recorder smoke test evidence
First captured records (2026-05-10 14:26:48 UTC, BTC 15m, epoch 1778422500, secondsIntoEpoch=708):
- `yesPrice=0.16, noPrice=0.83, bestAsk=0.17, bestBid=0.16, askDepthShares=618.06, bidDepthShares=133.53`
- `structural: { direction:"DOWN", moveBps:-3.85, dataAgeSec:48, ok:true }` (Binance 1m closed candle)
- `strategySetSize=4, matched=[]` — current structural strategies correctly not matching because entry-price gate (0.30–0.45) excluded 0.16
- No exceptions; `rejectReasons=null` means strategies were cleanly evaluated

This proves the recorder captures the exact snapshot a live decision would use, enabling truthful Phase 3 forward-validation.

### Phase 0.5 — Live state audit (full dump)
- `orchestrator.lastRun=2026-05-10T14:03:30.391Z`, `marketsChecked=12`, `candidatesFound=0` (guard working)
- `riskControls.currentTierProfile={"maxPerCycle":1,"stakeFraction":0.4,"label":"BOOTSTRAP"}`
- `riskControls.drawdownBrake.active=true`, `drawdownPct=0.553`, `effectiveStakeFraction=0.12`
- `configuredTimeframes`: 5m enabled, 15m enabled, 4h disabled (minBankroll=3 for each)
- `telegram.deliveryStats`: 9 enqueued / 9 sent ok / 0 failed

## 🧰 Reproduction Commands (copy-paste)

```powershell
# Local verification (always run before anything else)
node --check server.js
node scripts/verify-harness.js
node scripts/test-close-window-guard.js

# Data refreshes (run from repo root)
node scripts/collect-intracycle-gap-fill.js
$env:FETCH_TIMEFRAME='5m'; $env:FETCH_DAYS='14'; node scripts/fetch-recent-cycle-cache.js
$env:FETCH_TIMEFRAME='4h'; $env:FETCH_DAYS='14'; node scripts/fetch-recent-cycle-cache.js

# Live state snapshot
Invoke-RestMethod -Uri 'https://polyprophet.fly.dev/api/health' -TimeoutSec 20 | ConvertTo-Json -Depth 6
Invoke-RestMethod -Uri 'https://polyprophet.fly.dev/api/status' -TimeoutSec 20 | ConvertTo-Json -Depth 6

# Cosmetic-stats rebase (ONLY when operator approves)
# Preserves trade history but clears $249 phantom todayPnL and stale peak
# Requires no secret (confirmReset=true is the gate)
Invoke-RestMethod -Uri 'https://polyprophet.fly.dev/api/validator/reset' -Method POST `
  -Body (ConvertTo-Json @{confirmReset=$true; clearTradeLog=$false; preservePause=$true}) `
  -ContentType 'application/json' -TimeoutSec 30
```

## 🚦 DO-NOT-DO List (absolute)

- **Do not** unpause live trading. Only operator may toggle `LIVE_AUTOTRADING_ENABLED`.
- **Do not** lower the $500+ median goal silently.
- **Do not** promote any strategy without an explicit confidence card + paper-shadow forward proof.
- **Do not** weaken any anti-overfit gate listed under Phase 2.1.
- **Do not** disable the close-window guard or the matched-shares normalization.
- **Do not** claim 100% certainty on any strategy. Always report LCB, bust rate, and honest forward expectation.

## 📝 Agent Handoff Instructions

**If you are picking this up from another agent:**

1. Read this file FULLY. Then read `README.md` for historical context. Then `.agent/skills/DEITY/SKILL.md` for protocol.
2. Run `node scripts/verify-harness.js` — must be 36/36 pass.
3. Run `node scripts/test-close-window-guard.js` — must pass.
4. Check background data-refresh status:
   - `Get-Content data/_gap-fill-15m.log -Tail 5`
   - `Get-Content data/_recent-5m-14d.log -Tail 5`
   - `node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync('data/intracycle-price-data.json'));console.log(j.cycles.length,'cycles, lastEpoch=',new Date(j.cycles[j.cycles.length-1].epoch*1000).toISOString())"`
5. Verify Fly state via `/api/health` matches "Current Verified State" table above (within tolerance of balance + drawdown).
6. Resume from the first unchecked `[ ]` box in the Phase list.
7. When a phase task is completed, tick its `[ ]` → `[x]` in this file and append evidence under "Evidence Captured So Far".
8. **Never skip phases.** If Phase 2 is tempting before Phase 1 paper-shadow data exists, resist: that's the same mistake the prior 8 searches made.

## 🚀 IMMEDIATE NEXT ACTION (whichever agent is next)

**Launch the 48h paper-shadow capture.** Every minute delayed = a minute of forward data lost. Run this in a new terminal that can stay open:

```powershell
# Full 6-asset, 5m+15m capture with 30s ticks (conservative for API limits).
# Creates data/paper-shadow/YYYY-MM-DD/<asset>_<tf>.jsonl
$env:PAPER_SHADOW_TICK_MS = '30000'
$env:PAPER_SHADOW_ASSETS   = 'BTC,ETH,SOL,XRP,BNB,DOGE'
$env:PAPER_SHADOW_TIMEFRAMES = '5m,15m'
node scripts/paper-shadow-recorder.js 2>&1 | Tee-Object -FilePath data/_paper-shadow.log
```

After ≥48h (or ≥200 captured match-opportunities across 5m/15m, whichever comes first), move to Phase 2 mining. Until then, Phase 2 can be designed (script scaffolding, hypothesis docs) but NOT finalized — the anti-overfit gates depend on comparing replay results to forward truth.

## 📌 Last-agent checkpoint

**Agent**: Cascade (DEITY protocol) · **Commit**: `1973d99` · **Time**: 2026-05-10 14:30 UTC

**Completed this session**:
- Phase 0.1, 0.2, 0.5 fully (runtime stats rebase mechanism, close-window property test + 36/36 verify-harness, Fly env safety audit)
- Phase 1.1 paper-shadow recorder built, syntax-clean, smoke-tested live (BTC + ETH 15m)
- Phase 1.2 determined unnecessary (reused production lib/* directly)
- Handover scaffold (this file + `progress.txt` + README top pointer)

**In flight (background)**:
- `0.3` 15m gap-fill running, last checked XRP 180/741 (final asset, ~5–10 min more)
- `0.4` 5m 14d fetch running, was 500/28231 at last check (may take 1+ hour; optional — 2d cache is sufficient for initial Phase 2)

**Pending (do next in order)**:
1. Launch paper-shadow recorder (command above).
2. Verify 15m gap-fill completed successfully (run the `node -e` command from step 4 above; expect cycles > 9000 and lastEpoch ≈ today).
3. Begin Phase 2.1: write `scripts/honest-strategy-search.js` skeleton + H1 (spread convergence) first — it's the simplest hypothesis and produces quick evidence for/against.
4. While recorder accumulates data, iterate H1–H5 in Phase 2.2.
5. After 48h capture reaches ≥200 matches, execute Phase 3 forward-validation.

**Known risks / caveats**:
- 5m and 15m structural strategies currently loaded on Fly are unfireable (close-guard blocks their entire match window). Do not be fooled if Fly shows 0 matches/day — the strategies are intentionally inert. Fly is safe-paused.
- The `$249` phantom `todayPnL` on Fly is cosmetic; trade history is correct. Operator may invoke `/api/validator/reset` with `clearTradeLog=false` when convenient. **Do not do this without operator approval** — it's their risk dashboard.
- Polymarket CLOB WRITE endpoints are geoblocked in UK; reads (book/price/prices-history) work direct. The paper-shadow recorder uses reads only.
