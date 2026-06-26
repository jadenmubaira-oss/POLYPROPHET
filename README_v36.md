
# README v36 - CENTRALISED HUB (updated 2026-06-25 local)

> **THIS IS THE SINGLE SOURCE OF TRUTH FOR THE ENTIRE PROJECT.**
> Every AI session reads this FIRST and updates it BEFORE finishing.
> All prior READMEs (v2-v35, v29 hub) are HISTORICAL REFERENCE ONLY — but must NOT be treated as gospel.
> Previous AIs may have hallucinated, missed things, been on the wrong trail, or dismissed ideas too early.
> ALWAYS RE-INVESTIGATE before accepting any prior conclusion.

---

## >>> RULE ZERO: NO PASSIVE MISINFORMATION <<<

**This is the single most important rule in the entire project. It overrides everything else.**

Previous AIs repeatedly stated incorrect things and WOULD HAVE LET THE OPERATOR BELIEVE THEM if the operator had not explicitly called them out. This is unacceptable. Examples:
- Claiming 41W/2L or 46W/2L when live was actually 0L (hallucinated loss data)
- Citing v13's paper stats (cap 0.97-0.99 config) as evidence against a different later gate/cap config (wrong config attribution)
- Saying the bot had 2 losses when it had 0 (fabricated data)
- Making claims about reconciliation amounts without verifying (stale/wrong numbers)
- Blocking strategies as "too risky" without evidence, while the operator wanted MAX profit

**The fix is not just "be more careful." The fix is STRUCTURAL:**
1. Before stating ANY fact, ask yourself: "Have I VERIFIED this from a primary source, or am I assuming/remembering?" If assuming, STOP and verify.
2. After writing ANY answer, re-read it and ask: "If the operator took every claim here at face value, would any of them be wrong?" If yes, fix BEFORE sending.
3. If you realize mid-conversation that something you said earlier was wrong, IMMEDIATELY correct it — do not wait for the operator to notice.
4. Never present a claim with false confidence. If evidence is weak, say so. If you haven't checked, say "I have not verified this" rather than stating it as fact.
5. The operator should NEVER have to be the one catching your errors. That is YOUR job. If the operator catches an error you should have caught, that is a failure of this rule.

**This rule exists because misinformation ruins investigations.** One wrong number, one misattributed finding, one hallucinated claim can send the entire investigation down the wrong path. Every previous AI session that produced misinformation wasted the operator's time and money.

---

## >>> MASTER AUDIT & INVESTIGATION PROTOCOL (PERMANENT — RUN EVERY PASS) <<<

**Read this in full at the start of EVERY session and DO it — not just read it. This single section
encapsulates ABSOLUTELY EVERYTHING the operator has ever asked for across every prompt, audit, and
prior README/hub. It exists so the operator never has to repeat himself again. If you are a fresh AI
with zero context: this is your standing order. You already know what to do — it is written here.**

This is deliberately phrased as a permanent charter, not a one-off task. It is written in imperative
form. "You" = whichever AI is running the current pass. There is no end state until the operator's
goal (Section 2) is met; until then, every pass re-runs this protocol.

### WHY THIS EXISTS (the recurring failure, stated plainly so you don't repeat it)
Every previous pass said "I have verified, I have done the deepest investigation" — and then a hidden
error surfaced that the *operator* had to catch (e.g. the fill rate was quoted as 24 → 17 → 4 → 10/day
across passes; the operator, not the AI, discovered the bot was actually doing ~4/day). **That is the
core failure.** Saying "verified" is not verifying. Running a script is not verifying. The ONLY thing
that counts is: you personally traced the primary source, character by character where it matters,
and cross-checked it against live runtime. Before you state ANY number this pass, ask yourself the
RULE ZERO question: *"Did I actually trace this to a primary source right now, or am I carrying it
forward / remembering / assuming?"* If the latter — STOP and trace it.

### THE FOUR STANDING MANDATES (every pass must serve all four)
1. **STRATEGY / GOAL MAXXING.** Push the current strategy for maximum profit, fastest, with bust /
   strand / variance / loss risk minimised. Quantify, do not hand-wave: compute the actual loss risk,
   the actual profit, the actual fills/day, the actual time-to-target — each from primary data.
2. **TRUTHFUL, RE-VERIFIED RESEARCH.** All research 100% valid and truthful. Re-check and re-validate
   BOTH the findings AND the methods used to reach them. Audit your own reasoning, methodology, and
   tooling — not just the result. A correct number reached by a broken method is a trap (it will
   break next time).
3. **CONTINUOUS SEARCH FOR SOMETHING BETTER.** At all times look for (a) a way to make the current
   strategy better, (b) a new strategy that runs concurrently and adds profit, or (c) a wholly new
   strategy/venue/mechanic — even one never discussed before. Crypto-adjacent and similar-framework
   is preferred (operator's words), but you have full creative freedom. "It's mathematically
   impossible" is FORBIDDEN until you have genuinely exhausted every avenue with evidence.
4. **REVERIFY PAST + PRESENT — A SHIP WITH NO HOLES.** Re-investigate prior conclusions (do not trust
   them as gospel) AND the present state. Cover all angles, edge cases, and run a PREMORTEM ("assume
   this blew up the bankroll in 2 weeks — what was the cause?"). Every atom, every line of code, every
   character must be checked and tested to confirm it does EXACTLY what is expected.

### THE DEEPEST-LEVEL FORENSIC METHOD (manual first; scripts are only a backstop)
The operator distrusts scripts because "things slip past scripts." Scripts are a regression backstop,
NOT proof. Proof is manual. For every pass:
- **A. Manual line-by-line read of the live trading path.** Open `lib/snipe-strategy.js`,
  `lib/trade-executor.js`, `lib/clob-client.js`, `lib/risk-manager.js`, `server.js`, `lib/config.js`
  and read the actual code. For each gate, sizing, and execution constant, map out in words EXACTLY
  what that line does and what it SHOULD do, then confirm they match. Do not paraphrase from memory —
  read the characters on the line.
- **B. Cross-reference code against LIVE runtime.** Pull `/api/status`, `/api/clob-status`,
  `/api/diagnostics`. Assert the deployed runtime equals the source you just read (mode, enabled,
  paperMode, brake, tradeReady sigType, halt, bankroll source, f, K, timeframes, gate). Code that
  looks right but runs differently is Trap C3/D2.
- **C. Cross-reference claims against the REAL ledger** (`scripts/fly-snipe-ledger.jsonl`). Recompute
  W/L, fills/day, entry-ask distribution, reject buckets from the raw records — never quote a stat you
  did not just recompute.
- **D. OBSERVED vs PROJECTED, ALWAYS LABELLED SEPARATELY.** This is the anti-inconsistency rule and
  the single most important quantitative discipline in this project. OBSERVED = measured from actual
  fills. PROJECTED = OBSERVED × (survival fraction of those fills under the CURRENTLY-DEPLOYED gate).
  Never build a timeline on a historical rate without first asking "would the gate live RIGHT NOW
  still admit those fills?" If a gate change cuts the historical rate by >20%, flag it loudly.
- **E. Honest math.** Per-fill edge from the ledger (~0.93%/fill at ask 0.99), the $36.7 single-loss-
  survival threshold, strand probability across a RANGE of loss-rate assumptions (never assume 0%
  loss from 0 observed losses — Trap A5; show the CI upper bound). $100-in-7-days is impossible from a
  single-digit bankroll (needs ~45-60 fills/day; market gives ~17-24, less under the deployed gate) —
  state the honest day-N figure instead. ALSO each pass: (i) the LIQUIDITY CAP — where/when the book
  stops filling our growing size (median fill caps ~B$177, fully linear by ~B$3,425), the profit/fill
  AND profit/day at that cap, and the realistic MAX — these are upper bounds (deep BTC books vanish
  ~76% near close), never promises; (ii) COMBINED-portfolio profit AND each strategy's INDIVIDUAL
  profit, stated separately (today they are equal because only SNIPE clears break-even).
- **E2. Standing deliverable: the day-by-day table to 6 months.** The operator wants, on request, a
  day-by-day balance/profit/risk table out to 180 days for each config (conservative / base-deployed /
  optimistic), with the time-to-$100 row. Build it from real ask×depth (`scripts/v36-perf-review.js`
  → `...-daybyday.csv`), label OBSERVED vs PROJECTED fills/day, and mark every figure past ~$3,425 as a
  liquidity-linear ceiling, not exponential.
- **F. Trap sweep.** Walk the entire Section 6 failure register, the Section 14 reference list, AND the
  `README_v29_CENTRAL_HUB.md` §5A v1→v28 register; confirm this pass falls into none of them; add any
  NEW trap you discover.
- **G. Backstop script.** Run `node scripts/v36-forensic-audit.js` (sections A–G; exit 0 = OK). It
  parses gate constants FROM source (so it cannot drift), checks code-vs-runtime, recomputes
  OBSERVED-vs-PROJECTED, prints honest bust/profit math, and prints a manual trap checklist. Treat its
  PASS as necessary-but-not-sufficient — it does not replace the manual read above.

### ALWAYS-ON FORWARD DATA RECORDER (standing background infrastructure — keep it running LOCALLY)
A future investigation is only as good as the data it has. Keep the per-second recorder running on the
operator's always-on LOCAL PC at all times (NOT on the Fly trading VM — that VM is shared-1cpu/1GB and
a 28-market/second recorder co-located would compete with last-second order placement and could cost
fills; the recorder is read-only and never imports the executor, so it is zero-risk off-box).
- Records EVERYTHING, every second: full CLOB depth ladder + spot for every active crypto up/down
  market (`scripts/forward-second-clob-collector.js`, schema v2).
- Self-compresses: lossless gzip of each completed UTC day at startup and on day rollover (~20×;
  round-trip verified). Disable only via `FORWARD_COLLECTOR_COMPRESS=0`.
- Background + crash-resilient: `scripts/run-forward-collector-supervised.js` relaunches on crash;
  `scripts/start-forward-collector.cmd` is the background launcher.
- Auto-start on restart: `powershell -ExecutionPolicy Bypass -File scripts/install-collector-autostart.ps1`
  registers a Windows Scheduled Task (At-Logon, restart-on-stop). Analyzer
  `scripts/analyze-forward-second-clob.js` reads `.jsonl.gz` transparently so compaction never hides data.
- Every pass: confirm the recorder is actually writing today's snapshots on the local box, and that
  yesterday's folder compressed. If it is not running, that is a finding to report.

### STANDING STRATEGY LEDGER (re-verify each before re-deriving — do not just trust)
Current deployed config IS the speed-vs-safety optimum from this bankroll, BUT re-test the boundary
every pass: SNIPE taker at ask≈0.99 with z≥3 is the only thing that clears the 99.07% break-even.
Killed-with-evidence (re-confirm, don't re-litigate from scratch unless new data): cross-asset
momentum at cheap asks (market already priced in), Hyperliquid perps (negative mean continuation),
buy-every-cycle at 0.45 (6-18% overround), wider z gates (below break-even), maker limit bids (= the
existing deep fills, ~0.5/day), streak reversal (0 fills ever), 5m (edge REAL but fillability-capped
~1/day; on the DEPLOYED gate its loss rate is actually LOWER than 15m, so the old "~1.8x riskier" did
NOT reproduce — §13T; only ~1-2/day even if enabled). The ONLY lever that materially raises fills
(reopening the 1h tLeft>120 window) is a CONFIRMED LIVE NET LOSER (1h = 41W/1L = −$25.11 net; its fills
live only in the wide tLeft 301-600 reversal window; §13T) — not merely risky — so it is rejected
unless new evidence overturns that. If you find ANY new edge,
it must clear break-even at its fill ask AND translate 1:1 to live before you recommend it.

### OPERATOR HARD RULES (always in force — these are non-negotiable, from every prompt)
- **Testing window:** 24h max for any test. No 1–2 week paper periods. Use backtests, live API fetches,
  simulations, and the forward recorder. A 24h FAK/shadow test is explicitly allowed when it would
  settle a live-trading-order-type question with evidence.
- **Ask if unclear:** if anything about the goal, a config, or an instruction is ambiguous, ASK the
  operator — do not guess and do not silently pick a path.
- **No new READMEs** unless truly necessary; update THIS file. Keep the handover chain seamless
  (Section 12) so the next AI continues with zero context loss.
- **Repo-wide scope:** the line-by-line read prioritises the live trading path (method A), but if a
  change or finding touches ANY other file, that file must get the same character-level read before you
  rely on it. "Every single file" applies to everything in scope for the pass — never assume an
  unread file is correct.
- **Standing backup:** a full portable backup (`POLYPROPHET_FULL_BACKUP_*` → app/ + SECRETS/ +
  RESTORE.md, mirrored to USB) must exist and be current enough to stand the bot up on a brand-new
  PC/Fly account with nothing to re-type. If you change config/secrets, refresh the backup or flag it.
- **Don't be timid (Trap H3):** the operator wants MAX profit fastest with min bust/strand/variance/
  loss — not max safety. Push the boundary; only fall back to the safer knob (z≥4) when evidence
  demands it.

### COVERAGE MAP (every recurring operator point → where it is satisfied — keep this complete)
This is the explicit answer to "is everything included?". If you add a new standing instruction, add a
row here so the map never goes stale.
| Recurring operator point | Where it lives in this protocol |
|---|---|
| No passive misinformation / triple-check / self-correct | RULE ZERO (top) + Mandate 2 + checklist |
| Deepest manual forensic read, char-by-char, not just scripts | Method A; scripts = backstop (G) |
| Code must equal live runtime at every stage | Method B |
| Recompute every stat from the real ledger | Method C |
| The 24→17→4→10/day inconsistency must never recur | "WHY THIS EXISTS" + Method D (OBSERVED vs PROJECTED) |
| Calculate ACTUAL loss risk + ACTUAL profit + fills/day + time-to-target | Method E + checklist |
| Liquidity: will orders fill, where does it cap, profit/day at cap, max | Method E(i) |
| Day-by-day table to 6 months, per config | Method E2 |
| Combined-portfolio AND individual-strategy profit | Method E(ii) |
| Strategy/goal maxxing, min bust/strand/variance/loss | Mandate 1 + Operator Hard Rules |
| Continuous search for better/concurrent/new strategy (any venue) | Mandate 3 + Standing Strategy Ledger |
| "Mathematically impossible" forbidden until exhausted | Mandate 3 |
| Reverify past conclusions (not gospel) + present + premortem | Mandate 4 + Method F |
| Trap sweep (Section 6 + 14 + hub 5A) + add new traps | Method F |
| Findings must translate 1:1 to live | Mandate 1 + Strategy Ledger |
| 24h test window / FAK shadow test allowed | Operator Hard Rules |
| Ask operator if unclear | Operator Hard Rules |
| Update this README, no new ones; seamless handover | Operator Hard Rules + checklist + Section 12 |
| Always-on local per-second self-compressing recorder, autostart | "ALWAYS-ON FORWARD DATA RECORDER" |
| Full portable backup to USB for clean switchover | Operator Hard Rules + Section 11/§13E |
| "Why do past passes keep slipping / what stops 100% accuracy" | checklist (final item) |
| Auto-audit script as regression backstop | Method G |

### END-OF-PASS CHECKLIST (do every item; do not declare "ready" until all are true)
- [ ] Manually read the live trading path line-by-line this pass (not just syntax-checked).
- [ ] Code == live runtime, asserted from the API this pass.
- [ ] Every number recomputed from a primary source this pass; OBSERVED vs PROJECTED labelled.
- [ ] Loss risk, profit, fills/day, and time-to-target each quantified honestly with CI/ranges.
- [ ] Liquidity cap (where/profit-at-cap/max) + combined-vs-individual profit addressed; day-by-day
      table refreshed if requested.
- [ ] Searched for a better/concurrent/new strategy this pass and recorded the result.
- [ ] Asked the operator about anything ambiguous instead of guessing; portable backup still current.
- [ ] Premortem done; Section 6 + 14 trap sweep done; new traps recorded.
- [ ] Forward recorder confirmed running + compressing locally.
- [ ] `node scripts/v36-forensic-audit.js` run; verdict recorded; WARNs explained.
- [ ] Self-review against RULE ZERO: "if the operator believed every claim here, would any be wrong?"
- [ ] README updated with this pass's findings (no new README unless truly necessary).
- [ ] Asked yourself "why did past passes keep slipping?" and named what you did differently.

---

## 0. WHAT HAPPENED

On 2026-06-19, between ~11:37 and ~13:29 UTC, the bot took its FIRST LOSS on a **1h BTC** cycle.
- Pre-loss state: **175W/0L**, primary loss-record sizing balance **$35.757303**
- Post-loss state: **176W/1L**, bankroll **$6.036513**
- Loss amount: **$29.7214** (30-share 1h deep-window loss at ask 0.99)
- This was EXACTLY predicted by v34's survivability model: "one deep-book loss cost $29.5560, balance after $5.9314"

Primary-ledger correction (2026-06-21f/13M): older text in this file used rounded/stale values
(`~$29.45`, `tLeft≈400`, `$35.487393`). The authoritative loss record is `BTC 1h`, `shares=30`,
`ask=0.99`, `sig.tLeft=600`, `pnl=-$29.7214`, `liveBalanceAtSizing=$35.757303`,
`liveBankrollAfter=$6.036513`.

The loss was on the **1h** timeframe. The 15m timeframe has NEVER lost live. This is a critical distinction:
- 15m live: **~170+ W / 0L** (exact split needs re-verification from live state)
- 1h live: lost on BTC — the 1h window is structurally riskier (longer exposure to reversal)
- Lower ask caps protected against the v12 final-window losses (which were at ask >= 0.98), but the BTC 1h deep sleeve still lost at ask 0.99 before `deepMax1h` was tightened to 120s.

**IMPORTANT CORRECTION**: v13's paper ledger (46W/2L, net -$8.04) was on a DIFFERENT configuration — those 2 losses were at ask ~0.96 and ~0.99. Do not apply v13's negative result to any later SNIPE posture without replaying that posture's exact gates from source.

---

## 1. CURRENT LIVE STATE (DATED POST-LOSS SNAPSHOT — 2026-06-19T13:29Z; re-pull before trusting)

> ⚠️ This table is a HISTORICAL snapshot from the moment right after the first loss. It is NOT the
> current state and the balance/W-L below are STALE. The bot has since had tightened gates deployed
> (1h deepMax=120, 15m bps≥25/10, K=2) and the bankroll has grown back into the low-double-digit
> range (treat as ~$10 USD). For the LATEST verified state, see the most recent §13x entry, and
> ALWAYS re-pull `/api/status` for the exact live figure — never quote the numbers below as current.

| Item | Value |
|---|---|
| Mode | LIVE |
| Strategy | Native Polymarket SNIPE |
| Timeframes | 15m, 1h |
| K (concurrent) | 1 |
| Hard entry cap | 0.95 |
| Stake fraction | 0.85 |
| Floor | 5.5 |
| Min shares | 5 |
| Wins | 176 |
| Losses | 1 |
| Settled | 177 |
| Open | 0 |
| Pending | 0 |
| Balance | $6.036513 USDC |
| Open exposure | $0 |
| Last error | NO_FILL_AFTER_RETRIES (benign) |
| Deploy image | registry.fly.io/polyprophet:deployment-01KVDAEER72DFQ4R6EKJHTK79D |
| Uptime | ~25h since 2026-06-18T12:16:49Z |

The bot is still LIVE and will attempt trades, but at $6.04 with floor $5.50, it can only place minimal 5-share orders with ~$0.54 margin before floor breach.

---

## 2. OPERATOR GOALS (UNCHANGED, DIRECTLY FROM OPERATOR)

These are NON-NEGOTIABLE constraints. Every strategy must be evaluated against ALL of them:

| Priority | Goal | Detail |
|---|---|---|
| 1 | MAX PROFIT | Absolute maximum profit possible. $100 USD in 7 days is the BARE MINIMUM target. |
| 2 | SPEED | Fastest possible path to higher profits. Speed of compounding matters. |
| 3 | MIN BUST/STRAND | Must not get stranded or busted. But operator accepts higher variance IF upside is very high. |
| 4 | TRUTHFULNESS | What investigation/backtest shows MUST translate 1:1 to live performance. No overpromise. No underpromise.|
| 5 | MIN VARIANCE | Prefer predictable outcomes, but this is subordinate to profit speed. |

**KEY OPERATOR STATEMENTS (direct quotes, paraphrased):**
- "I don't mind if 1 loss can wipe out bankroll, but I want to be positive/sure we won't get that one loss"
- "I'm fine with a strategy that may lose multiple times, but still have high upside because winners outweigh losers"
- "All I want to be sure of is that I am going to get the profit expected in the time expected"
- "Nothing like luck or variance will be the end of me / result in being stranded/bust"
- "You can completely change strategy, can be completely new, not even one considered before"
- "Can use different venues (must be accessible from UK ideally, or can move countries for server but must be viewable/interactable from UK)"
- "You are allowed completely free reign"
- "I am OK with sticking with current strategy if it can be fixed and bust risk mitigated even further (15m only = even less chance of bust) + profit maximised"
- "Ideally I want better for my goals though - more profit, quicker profit"
- "If possible, acquire ALL data from Polymarket (or whatever venue) up to current date and analyse for strategies, patterns etc"
- "Can forward-collect data for max 24 hours"
- "Has completely free selection on strategies — can mix, replace, do absolutely anything"
- Starting bankroll: **$6.04 USDC** (was $10 after withdrawal, grew to $35.49 with deposit + wins, now $6.04 after loss)

**THE GOAL IN ONE SENTENCE**: Get the absolute maximum profit possible ($100/7d bare minimum), as fast as possible, with bust/strand risk truly mitigated — and whatever investigation shows MUST translate 1:1 to live. The AI must work CONSTANTLY toward this goal, never lose sight of it, and ask the operator for clarification if needed.

---

## 3. WHY THE CURRENT STRATEGY FAILED THE GOAL

### The math problem
Historical high-f SNIPE framing after the first loss (superseded for current gates by §13L/§13M) with f=0.85:
- Win profit per 5-share trade: ~$0.23
- Win profit per deep-book trade (31 shares at $35 bankroll): ~$1.44
- Deep-book loss cost: ~$29.56
- **Win/loss ratio: need ~129 wins to recover ONE deep-book loss**
- At ~15 fills/day, that's ~8.6 days just to recover

### The speed problem
Even at 176W/0L, the bot only grew from ~$10 to ~$35 over several days. That's ~$25 profit across 176 wins = ~$0.14 average profit per win. At 15 fills/day, that's ~$2.13/day average.

### The fragility problem
The strategy was described as "practically 0-loss" based on backtests showing ~1500W/2L with the prior whipsaw losses mitigated by tighter ask caps. But:
- v31 showed per-trade loss probability upper bound of 1.84% (Clopper-Pearson 95% CI from 161W/0L)
- The actual loss rate turned out to be 1/177 = 0.56%
- At 0.56% loss rate with current sizing, expected time between losses: ~177 trades / 15 per day = ~12 days
- One loss wipes ~12 days of profit

### The structural conclusion
The current strategy at current sizing is too slow for the goal ($2.13/day average). BUT:
- The core SNIPE edge (buying near-certainty binary outcomes) IS real — 176W/1L proves it works
- The loss was on **1h**, not 15m. 15m-only may be structurally much safer
- The problem is the COMBINATION of: high stake fraction + 1h exposure + low frequency
- Possible fixes: 15m-only (eliminate 1h risk) + bust mitigation + profit maximisation
- OR: completely new/different strategy that better serves the goal

**DO NOT DISMISS the current strategy without first investigating whether 15m-only + bust mitigation + profit-max could work.**

---

## 4. STRATEGY OPTIONS FOR NEXT AI (OPEN FIELD)

The operator has given COMPLETE CREATIVE FREEDOM. The next AI should investigate ALL of these and any others it can think of:

### A. Fix/improve current SNIPE (Polymarket binary options)
- Lower stake fraction so losses don't kill bankroll (but reduces per-win profit)
- Multi-asset diversification (spread risk across assets/timeframes)
- Better entry selection / skip filter (avoid the cycles that lose)
- The core edge (buying near-certainty outcomes at 0.95) may still be valid if sizing is fixed
- **Problem**: $100/7d is impossible from a single-digit/~$10 bankroll even with perfect execution (the honest path is multi-week — see MASTER PROTOCOL Method E)

### B. Higher-frequency Polymarket trading
- Buy-every-cycle was fillability-disproven in v30 (winner asks vanish ~70% near close)
- Maker/limit entry (v33 shadow showed 3W/0L proxy fills but queue-uncertain)
- Earlier entry with looser gates (v32 showed wider z2@0.95 went 0W/2L in forward test)
- **Problem**: the fundamental fillability wall near close hasn't been solved

### C. Completely new Polymarket strategies
- Cross-market arbitrage / negative-risk baskets (capital-hungry, needs more than $6)
- Event-driven trading on new market creation / resolution
- Market-making (post bids and asks, earn spread)
- Multi-leg positions across correlated markets

### D. Different venues entirely
- **Hyperliquid** perp trading (UK accessible; prior paper tests were poor but logic was flawed)
- **Other prediction markets**: Kalshi (US-only, may need VPN), Manifold (play money)
- **DeFi yield**: Aave, Compound, liquidity provision (low yield, won't hit $100/7d from ~$10)
- **CEX spot/futures**: Binance (accessible from UK with restrictions), Bybit, etc.
- **Sports betting APIs**: Betfair Exchange (UK based, allows algorithmic trading)
- **Any other venue the AI discovers** that is accessible from UK and has edge potential

### E. Combination strategies
- Run SNIPE at reduced sizing + a second strategy on another venue
- Use SNIPE profits to fund a higher-leverage play elsewhere
- Diversify across uncorrelated edges

### F. The operator's preferred investigation priorities
**PRIORITY 1: Can the current strategy be fixed?**
- 15m-only (disable 1h) — the live loss was on 1h, 15m has NEVER lost live
- What caused the 1h loss specifically? Can that exact mechanism be prevented?
- Can bust risk be further mitigated while keeping or increasing profit?
- Can profit/speed be maximised (more fills, larger sizing, better compounding)?

**PRIORITY 2: BUY EVERY CYCLE or close to every cycle at ~99c (or slightly cheaper)**
- This was the operator's #1 idea from the start
- v30 found fillability issues near close, but:
  - What about EARLIER entry (deep window, tLeft 60-600s)? Fillability is 70.8% at cap 0.95 deep
  - What about MULTIPLE entries per cycle at different times?
  - What about a SKIP FILTER that avoids dangerous cycles?
  - The operator wants this followed ALL THE WAY TO THE END

**PRIORITY 3: Completely new strategies**
- Acquire ALL available Polymarket data and analyse for patterns/edges
- Can forward-collect for up to 24 hours
- Any venue, any strategy, any combination — total creative freedom

**CRITICAL: Do NOT dismiss ANY idea without exhaustive evidence. Previous AIs may have been wrong.**

---

## 5. WHAT THE LAST INVESTIGATION FOUND (v30-v35 summary)

| Pass | Date | Key finding |
|---|---|---|
| v30 | 2026-06-18 | Buy-every-cycle fillability-disproven: winner asks vanish ~70% near close. Live 161W/0L. |
| v31 | 2026-06-18 | Frequency-vs-winrate frontier: more frequency by raising cap toward 0.99 is EV-negative OOS. Live 0.95 lane was EV-safe with ~2.5x margin for the v31 OOS loss set. Later v36 live 1h loss required separate `deepMax1h=120` mitigation. |
| v32 | 2026-06-19 | 1h should stay ON; 5m EV-negative; wider gate no free lunch; confluence (book+momentum) disproven; deposit buys speed not loss-absorption. Live 167W/0L. |
| v33 | 2026-06-19 | Launched two ~24h forward shadows: wider z2@0.95 gate + maker/limit at 0.94. |
| v34 | 2026-06-19 | Deposit reflected ($35.49). Wider-gate shadow: 0W/2L negative. Maker shadow: 3W/0L proxy but queue-uncertain. |
| v35 | 2026-06-19 | All-price fillability from 44GB tape: winner vanishes 76.3% near close (168x larger sample confirms v30). Disk analysis: 44GB condensable to ~1.2GB. |
| **v36** | **2026-06-19** | **FIRST LOSS: 1h BTC, $29.7214 deep-window loss, primary loss-record balance $35.7573 -> $6.0365. Strategy pivot required.** |

---

## 6. KNOWN TRAPS AND FAILURE REGISTER (v1-v36, MUST READ)

These are real mistakes from the project history. Every new strategy/investigation MUST avoid ALL of them.
**BUT: these are traps to AVOID, not reasons to dismiss strategies. Previous AIs may have drawn wrong conclusions from real traps. Always re-investigate.**

### Strategy/Stats traps
- **A1** (v6/v7): Survivorship-biased backtest (tested only winning params, ignored losing ones)
- **A2** (v7): Overfitting to in-sample data without OOS/walk-forward validation
- **A3** (v12): Strategy looked good on paper, performed differently live (no 1:1 translation)
- **A4** (v28): Merging different counters (active state vs ledger verifier) into one claim
- **A5** (v31): Treating 0 observed losses as 0 loss probability (loss-prob bound was 1.84%, actual was 0.56%)
- **A6** (v36): One-loss-kills-bankroll sizing at high stake fraction with 1h enabled. 176W/1L net negative.
- **A7** (v36 CORRECTION): v13's 46W/2L paper ledger (net -$8.04) was on a DIFFERENT config (caps 0.96-0.99). Do not cite v13 paper stats as evidence against any later SNIPE config without replaying that config's exact gates from source.

### Fill-reality traps
- **B1** (v25): Assuming all signal entries fill (40/126 = 32% actual fill rate)
- **B5** (v30): Winner asks vanish ~70% near close (fillability wall) — but RE-INVESTIGATE: does this hold for earlier entry? Different assets? Different conditions?
- **B8/B9** (v35): 76.3% vanish rate confirmed on 168x sample — same caveat, re-investigate for different entry timing
- **B10** (v31): Profit-greedy backtest selector bias
- **B11** (v32): 1h must be tested in its deep window (tLeft 60-600s), not 15m window

### Config/secrets traps
- **C1** (v7): API key rotation broke live trading silently
- **C2** (v13): Wrong env vars deployed, bot traded differently than expected
- **C3** (v28): Config surface said 1h was off while ledger showed 1h trades

### Process/infra traps
- **D1** (v6): Deploy without postdeploy verification
- **D2** (v12): Assuming code change is correct without running it
- **E3** (v30): Using stale data for current claims

### Accounting traps
- **F1** (v26): Balance/sizing not refreshed from live wallet
- **F6** (v32): Fixed-5-share survivability is optimistic (deep-book sizing = much larger loss)
- **F7** (v36): Strand-guard does NOT prevent catastrophic loss - only ensures minimum floor survival

### Loss mechanism
- **G1** (v31): The 2 OOS backtest losses were final-window reversals at ask >= 0.98 — the 0.95 cap rejects these
- **G2** (v36): LIVE LOSS on **1h** BTC confirms losses CAN happen in the 1h deep sleeve (the primary loss record was ask 0.99, `tLeft=600`). But 15m has NEVER lost live. The 1h and 15m timeframes have different risk profiles.

### AI/investigation traps (META - about the investigation process itself)
- **H1**: Previous AIs hallucinated data (e.g. claiming 41W/2L when live was 0L)
- **H2**: Previous AIs dismissed strategies too early without exhaustive evidence
- **H3**: Previous AIs were too conservative/timid — operator wants MAX profit, not max safety
- **H4**: Previous AIs applied findings from one config to a different config (e.g. v13 paper on cap 0.97-0.99 applied to cap 0.95)
- **H5**: v11 investigated and "rejected" venues (cross-venue arb, DeFi, etc.) but those investigations may have been incomplete, on wrong assumptions, or conditions may have changed — RE-INVESTIGATE if relevant to goal
- **H6** (v36 CRITICAL): **PASSIVE MISINFORMATION — AIs stated wrong things and would have let the operator believe them if not called out.** This is the #1 meta-failure of the project. Wrong numbers, wrong config attributions, fabricated loss counts, stale reconciliation figures — all stated with confidence and only corrected when the operator explicitly challenged them. Every future AI must proactively self-check and self-correct. See RULE ZERO at top of document.
- **H7** (v36, 2026-06-21f/13M): **STALE IN-CODE DOCSTRING / COMMENTS.** The `lib/snipe-strategy.js` header docstring still stated the *pre-v36* gate (1h `(60,600]`, 15m deep `bps≥20`, "ONE open snipe / f=0.85 flat") while the deployed runtime gate was already correct (1h deepMax 120, 15m deep bps 25, K=2, guarded f). A later inline comment in the same file still said the single live BTC 1h loss entered at `tLeft ~400s` and cost `~$29.45` after the primary ledger had corrected it to `tLeft=600` and `-$29.7214`. A manual reader trusting comments would mis-state the live gate/loss mechanism — the same class of trap as C3/H4. FIX: sweep code comments against the code itself and primary ledger every pass, not just the README; the `v36-forensic-audit.js` parser reads the CODE (not comments) so its gate-parse stays accurate. Header fixed in §13L; inline loss comment fixed in §13M. Related: live `fEff=0.5246` proves the strand guard lowers the true single-loss-survival bankroll to ≈$10.78, so the long-standing "$36.7 = one-loss-strand" framing (§13D, audit `survivable=36.7`) is a CONSERVATIVE upper bound, not the strand point — corrected in §13L Correction #2.

---

## 7. INVESTIGATION RULES (from operator, NON-NEGOTIABLE)

**RULE ZERO (see top of document): NO PASSIVE MISINFORMATION. This overrides all other rules.**

1. **Triple-check everything.** Check, recheck, check again. Verify your own thinking and reasoning. This is not optional and not a suggestion — it is a HARD REQUIREMENT. Every number, every claim, every conclusion must be verified against a primary source before stating it.
2. **Proactively self-correct.** If you realize something you said is wrong or uncertain, correct it IMMEDIATELY. Do not wait to be called out. Do not hope the operator doesn't notice. The operator should NEVER be the one catching your mistakes.
3. **Follow every line of enquiry ALL THE WAY TO THE END.** Don't dismiss anything without exhaustive evidence.
4. **Don't block early.** If you don't have evidence, GET IT. Only say "not proven" after you've tried everything.
5. **24 hours max for testing.** No 1-2 week paper periods. Use backtests, fetch data, run sims.
6. **1:1 truth translation.** What you say must match what happens live. No overpromise, no underpromise.
7. **Use previous bot performance as evidence.** 176W/1L is real data. Use it.
8. **Operator's goal is ALWAYS priority.** MAX profit, fastest, min bust/strand/variance/loss. $100+ profit target — honestly a multi-week compounding path from ~$10 USD (NOT 7 days; see MASTER PROTOCOL Method E).
9. **You have complete creative freedom.** New strategies, new venues, combinations, replacements - all allowed.
10. **Plan before every answer, review your plan, do the work, review your work and thinking.**
11. **Update handover files before finishing.** Next AI must be able to continue seamlessly.
12. **Distinguish verified facts from assumptions.** When presenting information, explicitly mark whether each claim is: (a) verified from a primary source right now, (b) carried forward from a previous README (state which one), or (c) your own reasoning/estimate. Never blend these without labelling.

---

## 8. COLD-START TRIGGER (paste this into any fresh AI with zero context)

This trigger works from now until the project goal is met. Update it only if the goal or state fundamentally changes.

### Full version:
```
Read `README_v36.md` end to end — it is the SINGLE source of truth for this project, and
FIRST read + DO the MASTER AUDIT & INVESTIGATION PROTOCOL at the top (it encodes every standing
instruction; running it every pass is your standing order).

This is a Polymarket near-close binary SNIPE bot: it buys near-certainty crypto up/down outcomes
at ask ≈ 0.95-0.99 in the last seconds before each market settles. It is LIVE and near-lossless —
the only live loss to date was a single 1h BTC cycle; the 15m timeframe has never lost live.
Bankroll is small — treat it as ~$10 USD, and ALWAYS re-pull `/api/status` for the exact current
figure. Never trust a balance number written in this file; it goes stale.

YOUR GOAL (operator, non-negotiable): extract the absolute MAXIMUM profit, as FAST as possible,
with bust / strand / variance / loss risk minimised. Target is $100+ profit and then beyond. Be
HONEST about the timeline: from ~$10, $100 profit is a multi-week compounding path (~2-4 weeks at
the live fill rate), NOT 7 days — 7 days would need ~45-60 fills/day and the market only gives
~17-24 (fewer under the deployed gate). State the honest day-N figure; never overpromise (RULE ZERO).

You have COMPLETE creative freedom: new strategies, new venues, combinations, replacements,
acquire any data from Polymarket or other sources, forward-collect for up to 24h, run any scripts.

PRIORITY ORDER (re-verify each from primary data — do NOT trust prior conclusions as gospel):
1. MAX the current SNIPE: keep it near-lossless (1h restricted to the last ~2 min; 15m bps gate
   tightened) while squeezing the most profit/speed safely from this bankroll.
2. Find a BETTER / CONCURRENT / wholly NEW strategy (any venue, crypto-adjacent preferred) that adds
   profit. "Mathematically impossible" is FORBIDDEN until every avenue is exhausted with evidence.
3. The Standing Strategy Ledger (top) lists what is already killed-with-evidence — re-confirm, don't
   re-litigate from scratch unless you have NEW data.

RULES (RULE ZERO is most important — see top of document):
- RULE ZERO: NO PASSIVE MISINFORMATION. Verify every claim from a primary source before stating it.
  Re-read your output; if any claim would be wrong taken at face value, fix it BEFORE sending. If you
  realise something you said is wrong, correct it IMMEDIATELY — the operator must never have to catch
  your errors for you.
- Deepest-level MANUAL forensic verification (char-by-char on the live trading path); scripts are a
  backstop only, not proof. Code MUST equal live runtime; recompute every stat from the real ledger;
  label OBSERVED vs PROJECTED separately (this is what stops the recurring fills/day inconsistency).
- Triple-check ALL answers and reasoning. Previous AIs hallucinated data — verify everything.
- Do NOT treat previous README conclusions as gospel — re-investigate if relevant.
- Follow every line of enquiry to the END. Don't dismiss without exhaustive evidence.
- What you find in investigation MUST translate 1:1 to live performance.
- 24h max for any testing. Use backtests, live data fetches, simulations, the forward recorder.
- Update THIS FILE (README_v36.md) with findings. Do NOT create new READMEs unless truly necessary.
- Ask the operator questions if anything about the goal is unclear.
- Cross-reference all prior READMEs (v2-v35) for context but verify before trusting.
- Sections to read: RULE ZERO (top), MASTER AUDIT & INVESTIGATION PROTOCOL (top), 2 (goals),
  3 (why current failed), 4 (options), 6 (traps), 7 (rules), 10 (repo map).
- Also skim `README_v29_CENTRAL_HUB.md` for full v1-v28 history.
```

### Short version:
```
Read README_v36.md — single source of truth. FIRST read + DO the MASTER AUDIT & INVESTIGATION
PROTOCOL (top). Polymarket near-close binary SNIPE bot, LIVE, near-lossless (only live loss was one
1h BTC cycle; 15m has never lost). Bankroll ~$10 USD — re-pull /api/status for the exact figure.
Goal: MAX profit, FASTEST, min bust/strand/variance/loss; target $100+ profit (honestly a multi-week
path from ~$10, NOT 7 days). Priority: 1) max the current SNIPE safely, 2) find a better/concurrent/
new strategy (any venue), 3) re-confirm the killed-strategy ledger, don't re-litigate without new data.
RULE ZERO: verify every claim from primary sources; manual forensic read, not just scripts; code==live
runtime; OBSERVED vs PROJECTED labelled; findings must translate 1:1 to live. Triple-check everything.
Update README_v36.md with findings. Ask operator if unclear.
```

---

## 9. AI MODEL RECOMMENDATION (researched June 2026)

| Rank | Model | SWE-Bench Pro | Best for | Notes |
|---|---|---|---|---|
| 1 | Claude Fable 5 | 80.3% | Agentic coding, multi-step execution | Top benchmark score. May have availability issues (newly launched Jun 9). |
| 2 | Claude Opus 4.8 | 69.2% | Reliable primary workhorse | Stable, 15% fewer turns, strong at complex instructions. Recommended default. |
| 3 | GPT-5.5 | 58.6% | Long-context analysis (74% MRCR 128K) | Best at digesting entire README chain in one pass. Weaker on agentic coding. |
| 4 | Gemini 3.1 Pro | 54.2% | Budget option | Weakest on coding. Not recommended as primary. |

**For this project**: Use Opus 4.8 as primary (stable, strong coding). Try Fable 5 if available (higher ceiling). Use GPT-5.5 as second opinion for long-context analysis. The #1 failure mode has been AIs stating things without running code to verify — whichever model is used MUST actually execute scripts.

**The AI working on this project should work SEAMLESSLY and CONSTANTLY toward the operator's goal.** It should not stop at analysis — it should implement, test, deploy, and verify. Every session should produce measurable progress toward $100/7d.

---

## 10. REPO QUICK REFERENCE

| Item | Path |
|---|---|
| Bot server code | `server.js`, `lib/`, `strategies/` |
| SNIPE engine | `lib/native-snipe.js`, `lib/snipe-manager.js` |
| Trade executor | `lib/trade-executor.js` |
| Market discovery | `lib/market-discovery.js` |
| Backtest proof script | `scripts/v12-settlement-snipe-proof.js` |
| Auto audit | `scripts/auto_audit.js` |
| Survivability model | `scripts/v32-deposit-withdrawal-survivability.js` |
| Fillability probe | `scripts/v30-book-fillability-probe.js` |
| All-price fillability | `scripts/v35-allprice-fillability-miner.js` |
| Frequency frontier | `scripts/v31-frequency-winrate-frontier.js` |
| Paper shadow | `scripts/v32-paper-shadow.js` |
| Maker shadow | `scripts/v33-maker-limit-shadow.js` |
| Forward CLOB data | `data/forward-second-clob/` (~44GB, per-second full depth) |
| Central hub (historical) | `README_v29_CENTRAL_HUB.md` |
| All READMEs | `README_v2.md` through `README_v36.md` |
| Audit evidence | `audit_v28/` through `audit_v35/` |
| Fly config | `fly.toml` |
| Server URL | `https://polyprophet.fly.dev` |

---

## 11. SERVER BACKUP / RECOVERY

If the server needs to be restarted or moved:
1. Install Fly CLI: `powershell -Command "iwr https://fly.io/install.ps1 -useb | iex"`
2. Auth: `fly auth login` (browser popup)
3. Deploy: `fly deploy` from repo root (uses `fly.toml` + `Dockerfile`)
4. Secrets: must be re-set via `fly secrets set KEY=VALUE` (not stored in repo)
5. Required secrets: `POLYMARKET_API_KEY`, `POLYMARKET_API_SECRET`, `POLYMARKET_API_PASSPHRASE`, `PRIVATE_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
6. The bot auto-starts on deploy and begins trading if `TRADE_MODE=LIVE`

---

## 12. HANDOVER PROTOCOL

Before finishing your session:
1. **RULE ZERO CHECK**: Re-read your entire output. Is there ANY claim you haven't verified from a primary source? Any number you assumed rather than checked? Any finding from a previous README you repeated without re-verifying? FIX IT NOW.
2. Update THIS file (README_v36.md) with your findings — do NOT create new READMEs unless truly necessary
3. Include: what you tested, what worked, what didn't, exact numbers with sources. For each number, state WHERE you got it (live API pull, script output, previous README — and if from a README, whether you re-verified it).
4. Preserve all previous information — only remove if truly obsolete
5. Leave the investigation resumable — next AI should know exactly where to pick up
6. If you deployed anything, record the exact image tag and postdeploy verification
7. If you changed any config/secrets, record what and why
8. Run `node --check server.js` before any deploy
9. Triple-check your own reasoning before committing to conclusions
10. Ask the operator if ANYTHING about the goal or current state is unclear
11. The cold-start trigger (Section 8) should ALWAYS work — update it if state fundamentally changes
12. Never lose sight of the operator's goal: MAX profit, fastest, min bust/strand; $100+ profit target (honest timeline is multi-week from ~$10 USD, not 7 days — state the real day-N figure)
13. Cross-reference with prior READMEs but verify before trusting — previous AIs made errors
14. If you catch yourself about to state something you haven't verified, STOP. Verify it or explicitly mark it as unverified.

---

## 13. V36 SESSION FINDINGS (2026-06-19, verified from primary sources)

### Code changes deployed (image `deployment-01KVJ116N7WFMTP0Y1QTK1V4JW`, 2026-06-20 ~08:08Z)
1. **1h deepMax 600→120** (`lib/snipe-strategy.js` line 991): Restricts 1h entries to tLeft 60-120s.
   - Evidence: 30d backtest at tLeft 60-600 had 6 losses (all at tLeft>180). At tLeft 60-120: 1257W/0L.
   - Walk-forward validated: 926W/0L train + 796W/0L test = 1722W/0L across 6 assets.
   - The live 1h loss (BTC, -$29.7214) entered at tLeft=600 — this change prevents it.
2. **15m bps threshold 20/10→25/15** (`lib/snipe-strategy.js` line 1002): Raises deep-window bps floor from 20→25, final from 10→15.
   - Evidence: 30d backtest at bps≥20: 7059W/3L. At bps≥25: 6134W/0L (all 3 losses had bps 20-24).
   - Combined with 1h tightening: ~23 fills/day (vs ~24 before), 0 losses in 6134+1257=7391 backtest signals.
3. **Fly secret `PEAK_DRAWDOWN_BRAKE_MIN_BANKROLL=50`**: Was 0, which activated the drawdown brake at $7.27 bankroll (27.3% from peak $10 > 25% threshold), zeroing the effective stake fraction. Set to 50 so the brake only fires when peak exceeds $50.

### Rule Zero correction from 2026-06-20 rereview
The earlier post-deploy check was WRONG: `/api/status` does not expose `snipe.paperMode`; it exposes `snipe.mode`.
Top-level `isLive:true` was not enough. The SNIPE module had restarted in **PAPER** because persisted `/data/snipe/state.json` control (`paperMode:true`) overrode the env default.

Fix deployed in image `deployment-01KVJ60TMW43AZN0EEWRHV6R5K` (2026-06-20 ~09:35Z):
- Set Fly secret `SNIPE_PAPER_MODE=false`.
- Patched `lib/snipe-strategy.js` so an explicit `SNIPE_PAPER_MODE` env value overrides stale persisted `control.paperMode`; if env is absent, persisted Telegram/control behavior remains.
- Post-fix `/api/status` verification: `isLive:true`, `snipe.mode:LIVE`, `snipe.sizingSource:live-cached-wallet`, `snipe.bankroll:7.2654`, `snipe.liveBankroll:7.2654`, `snipe.enabled:true`, `snipe.allowedTimeframes:[15m,1h]`, `drawdownBrake.active:false`, no open/pending positions, `lastError:null`.

Ledger verification from downloaded `/data/snipe/ledger.jsonl` (`scripts/fly-snipe-ledger.jsonl`):
- Total `ENTRY` rows: 196 = 99 live + 97 paper.
- Live matched entries: 99/99 `MATCHED`; live order rejected rows: 279.
- Recent starts after the 08:08 deploy were `mode:PAPER` until the 09:35 fix; recent paper wins must NOT be counted as live compounding.
- Historical live matched rate from ledger: 99 entries over 5.694 days = 17.39 fills/day. This was under older gates, not a proof that the newly tightened config will hit 23/day live.

### Liquidity verification (live Polymarket order books + ledger rereview)
- Checked all 6 crypto assets (BTC/ETH/SOL/XRP/DOGE/BNB), both 15m and 1h markets
- One spot order-book sample found depth at ask ≤0.99: min=285, median=2,904, max=14,428 shares. **This is optimistic for 6-month projections because books change and SNIPE often trades shallow best/cap depth near close.**
- Ledger cap-depth from actual `ENTRY` rows: min=5, median=152, max=7,787.69 shares. This is the safer base for long-horizon projection.
- With median ledger cap-depth 152, position size becomes liquidity-capped around bankroll ≈ `152 * 0.990713 / 0.85 = $177`; growth then becomes roughly linear rather than exponential.
- At the current ~$7 bankroll, liquidity is enough for the minimum 5-6 share order. The real near-term constraint is matched fills/day and loss risk, not depth.

### Monte Carlo/projection caveat (old 2904-depth projection is liquidity-optimistic)
| Loss rate | Source | Survive 180d | P($100+ by d16) | Median d16 | Median d30 | Median d90 |
|-----------|--------|-------------|-----------------|------------|------------|------------|
| 0% | Deterministic | 100% | 100% | $120 | $1,537 | $37,919 |
| 0.01% | Optimistic | 98.1% | 96.3% | $120 | $1,537 | $37,919 |
| 0.03% | Bayesian mid (0/6134) | 94.3% | 89.6% | $120 | $1,537 | $37,919 |
| 0.05% | 95% CI upper bound | 90.0% | 83.3% | $120 | $1,537 | $35,015 |
| 0.10% | Conservative | 80.1% | 69.8% | $120 | $249 | $29,170 |
| 0.20% | Pessimistic | 58.2% | 48.1% | $19 | $218 | $12,328 |

The table above is retained for reference, but it assumes 23 fills/day and 2904-share depth. Rereview conclusion: use it only as an optimistic case, not a base case.

Generated files from rereview:
- `scripts/v36-rereview-options.js` — projection generator.
- `scripts/v36-rereview-day-by-day.csv` — full day-by-day table to day 180 for all compared configs.
- `scripts/v36-rereview-summary.md` — readable option summary.

Corrected deterministic zero-loss option table from `scripts/v36-rereview-options.js` (start `$7.265436`, ask=0.99 cost/share `$0.990713`, profit/share `$0.009287`):
| Config | Status | f/day | depth cap | target day | d7 | d16 | d30 | d60 | d90 | d180 |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| B deployed, optimistic spot-depth | deployed/live; depth sample optimistic | 23 | 2904 | 16 | $24.53 | $124.40 | $1,595.65 | $19,437.51 | $38,046.43 | $93,873.18 |
| **B deployed, ledger-depth base** | deployed/live; more realistic long-horizon depth cap | 23 | 152 | 16 | $24.53 | $124.40 | $568.64 | $1,542.66 | $2,516.68 | $5,438.74 |
| **B deployed, live-rate caution** | deployed/live; use until 24h forward fill rate confirms 23/day | 17.4 | 152 | 21 | $18.14 | $61.42 | $331.39 | $1,068.26 | $1,805.13 | $4,015.73 |
| 15m-only realized-rate caution | available by disabling 1h; slower | 10 | 152 | 35 | $12.22 | $24.34 | $72.77 | $441.59 | $865.08 | $2,135.54 |
| z≥4 safest estimate | not deployed; slower safer candidate | 12 | 152 | 30 | $13.59 | $31.22 | $116.79 | $610.99 | $1,119.17 | $2,643.72 |
| K=2 after $25 candidate | not deployed; unvalidated concurrency risk | 34.8 | 152 | 11 | $46.67 | $380.34 | $1,068.08 | $2,541.82 | $4,015.55 | $8,436.76 |

Rereview recommendation: keep current B deployed for now, but monitor the next 24h. If live matched fills are materially below ~17/day or if rejections dominate, the day-16 target is optimistic and the live-rate caution path (day ~21) is the more honest base case. Do NOT deploy K=2 until bankroll is high enough and forward evidence shows concurrent exposure does not increase bust risk.

**Deterministic day-by-day (0 losses):** use `scripts/v36-rereview-day-by-day.csv` as the current full day-by-day source to 180 days. The old short table was removed here because it assumed the optimistic 2904-share depth path and could mislead future sessions if read without the liquidity caveat above.

### Strategies investigated and killed (all verified from primary data)
| Strategy | Result | Evidence source |
|----------|--------|----------------|
| Cross-asset momentum (cheap asks) | 62.5% WR at ask≤0.70 (5W/3L on 8 trades) | CLOB + Binance backtest |
| Hyperliquid perps | Mean continuation = -1.0 bps, 30W/67L | 97-signal backtest |
| Buy-every-cycle at 0.45 | 6-18% overround kills EV | 10 cycle-start CLOB samples |
| Wider z gates (z≥2) | v32 shadow: 0W/4L at z=2.0-2.2 | Live shadow data |
| Lower z (z≥2.5/bps≥25) | 6879W/1L — close but still 1 loss | 30d backtest |
| Streak reversal | 0 fills in entire history | Live data |
| 5m timeframe | Only 1.2 fills/day | Live data |
| K=2 concurrent | Can't fund at $7 ($9.97 needed) | Math |

### Key constraints identified
1. **$7 bankroll + 5-share minimum = one loss = bust** — no position sizing can avoid this
2. **23 fills/day is not yet proven live under the tightened config** — ledger-proven live rate is 17.39/day under older gates; current config needs 24h forward confirmation
3. **$100 profit requires ~16 days only on the 23/day path; live-rate caution path is ~21 days**
4. **Liquidity cap is likely much earlier than $3,400 if using ledger-median cap-depth** — base-case long-horizon projection caps around ~$177 bankroll, while 2904-depth remains an optimistic spot-sample scenario

---

## 13C. V36 CONTINUATION (2026-06-20 ~15:00Z): trade-readiness, K=2, liquidity cap

### (1) Bot CAN trade — verified from primary endpoints, NO API-key problem now
- `/api/clob-status`: `tradeReady.ok=true`, `summary="OK sigType=3"`, `walletLoaded=true`, `hasCreds=true`,
  selected funder `0x49756E…6e97` `deployed=true` with unlimited USDC allowance, `balance=7.265436`, `closedOnly=false`.
- `/api/derive-debug`: the auto-derive creds path returns key/secret/passphrase and `proxyHealthCheck.status=200`.
  This is the recurring "no-trade / API key" fix (hub **E7/D3**): creds are runtime-derived via
  `POLYMARKET_AUTO_DERIVE_CREDS=true` + `POLYMARKET_SIGNATURE_TYPE=3` (both present in `fly.toml` AND as Fly secrets).
- `/api/health`: `isLive=true`, `liveModeBlockers=[]`, `usableForTrading=true`, `tradeFailureHalt.halted=false`,
  `errorHalt.halted=false`, `lastError=""`, bankroll `$7.2654` > floor `$5.5`, 15m+1h `active=true`.
- Conclusion: every gate required to place an order is GREEN. The bot only waits for a signal (z≥3/bps≥25 near close);
  `candidatesFound=0` at idle is normal, not a fault. **If the API-key problem ever recurs, re-check the derive path
  FIRST** (`/api/derive-debug`, `/api/clob-status` `tradeReady`), per hub E7.
- SECURITY NOTE (pre-existing, not changed here): `/api/derive-debug` returns the derived CLOB secret/passphrase in
  plaintext over the public URL. Consider gating it behind auth like `/api/clob/ready-debug` (which returns 401).

### (2) K=2 enabled (operator-directed) — `SNIPE_MAX_CONCURRENT "1"→"2"` in `fly.toml`
- Native SNIPE reads `SNIPE_MAX_CONCURRENT` (NOT `MAX_GLOBAL_TRADES_PER_CYCLE`). `setMaxConcurrent()` has no callers,
  so the env is the sole source; no persisted `/data` control and no overriding Fly secret exists → the `[env]` value is live after deploy.
- HONEST mechanics (verified in `lib/snipe-strategy.js` `_open`/`_openInner`/`_sizingSnapshot`): with f=0.85 the FIRST
  position consumes ~85% of bankroll, and a 2nd entry also applies f=0.85 to the post-first-fill live balance, so a 2nd
  5-share order (~$5) cannot fund until **bankroll ≈ $39**. Below that K=2 is **INERT** and risk-identical to K=1.
  Overcommit is impossible (same-tick entry-lock `_entryInFlight` + `cost>bankroll` skip + balance-aware resize retry).
- RISK once active (>~$39): K=2 **removes the single-slot mitigation (hub F4)** that capped a synchronized cross-asset
  whipsaw (hub **F1**, the one proven live loss mechanism) to ONE loss. With K=2, two concurrent positions can both lose
  in the same whipsaw cluster. At >$39 bankroll a single loss is survivable, but a 2-loss cluster is a larger drawdown.
- This RETRACTS the older "K=2 can't fund at $7 → leave at K=1" stance for this operator decision; it is still TRUE that
  K=2 has no effect until ~$39, so near-term speed is unchanged.

### (3) LIQUIDITY-CAP INVESTIGATION (verified) — `scripts/v36-liquidity-cap-investigation.js` (+ `…-output.txt`)
Primary source: 160 real `ENTRY` rows (`sig.capDepth` = cumulative shares ≤ askCap the bot actually saw at entry; 99 live + 61 paper).
Profit model `profit/win = shares*(1-ask-FEE(ask))`, `FEE=0.072*p*(1-p)` — validated 1:1 vs ledger SETTLE pnl ($0.0557 for 6sh@0.99).
Sizing: `shares=min(floor(f*B/(ask+FEE)), capDepth)`, so a fill is liquidity-capped when `f*B/(ask+FEE) > capDepth` → `B_cap ≈ capDepth*(ask+FEE)/f`.

**Pooled near-close capDepth (shares):** min 5 · p10 31 · p25 67 · **median 152** · p75 1,006 · p90 2,949 · max 7,788 · mean 884.

**Where each asset caps (median capDepth → bankroll where the cap STARTS to bind):**
| Asset/TF | n | median cap (sh) | caps at B≈ |
|---|---:|---:|---:|
| SOL/15m | 1 | 6 | $7 |
| DOGE/1h | 7 | 56 | $65 |
| BNB/15m | 25 | 61 | $71 |
| DOGE/15m | 30 | 77 | $90 |
| XRP/15m | 10 | 246 | $286 |
| ETH/1h | 19 | 251 | $292 |
| XRP/1h | 1 | 274 | $319 |
| ETH/15m | 9 | 858 | $998 |
| BTC/1h | 33 | 1,353 | $1,572 |
| BTC/15m | 25 | 1,596 | $1,833 |

**Exp→linear transition:** the MEDIAN fill starts capping at **B≈$177** (half of all fills capped beyond this — exponential
growth begins to slow); by **B≈$3,425** (p90 depth) essentially ALL fills are capped and growth is fully LINEAR.

**Day-by-day (deterministic 0-loss, expectation-per-fill over the real depth distribution, start $7.27):**
| Day | Bal @17 f/d | profit/day | Bal @23 f/d | profit/day | % fills capped (17) |
|---:|---:|---:|---:|---:|---:|
| 1 | $8.6 | $1.4 | $9.2 | $1.9 | 2% |
| 7 | $24.4 | $3.9 | $37.2 | $7.7 | 9% |
| 14 | $79 | $12 | $169 | $30 | 23% |
| 21 | $225 | $29 | $558 | $80 | 53% |
| 30 | $665 | $69 | $1,851 | $205 | 65% |
| 60 | $6,693 | $320 | $13,824 | $458 | 98% |
| 90 | $16,812 | **$339** | $27,568 | **$458** | 100% |
| 180 | $47,288 | $339 | $68,800 | $458 | 100% |

**Profit per trade & per day at the cap (the plateau):**
- Once liquidity-capped (B above ~$3,400), profit/trade plateaus at the full-sweep mean **≈$19.9/fill**, and daily profit
  plateaus at **≈$339/day (17 fills/day)** / **≈$458/day (23 fills/day)**. There is NO bankroll "max" — growth never stops,
  it just goes linear; the per-day DOLLAR rate is what plateaus.
- **Time to the plateau:** ~day 60 reaches ~$6.7k (17 f/d) and the daily rate is ~95–100% capped by ~day 60–90.

**HONEST caveats (do not over-trust the plateau dollar figure):**
- The mean profit/fill ($19.9) is **BTC-tail-skewed**: the MEDIAN fill at full sweep is only ~$1.4. The $339–458/day max
  depends on the deep BTC books (mean 884 sh) being present on EVERY fill. Near close the winner-side asks vanish ~76%
  (hub B8/B12), so at large size those deep BTC fills are NOT guaranteed → realistic sustained plateau is likely well below
  the mean-based figure. Treat $339–458/day as an upper bound, not a promise.
- fills/day is **NOT inflated for K=2** here (the 2nd slot rarely funds at f=0.85 until ~$39; even above that it competes
  for the same capital). K=2's real speed benefit is modest unless f is also lowered per slot.
- This is a **deterministic 0-loss** liquidity trajectory; bust/variance risk is separate (see the MC table above).
- Depth measured at entry instants on the local ledger snapshot; re-pull `/data/snipe/ledger.jsonl` for fresh depths before
  trusting beyond ~24h.

---

## 13D. V36 PERFORMANCE RE-REVIEW (2026-06-20 ~18:40Z): is it performing, loss mitigation, honest profit

### Is the bot performing as expected? YES.
- Live API (re-verified): `isLive=true`, `mode=LIVE`, `maxConcurrent=2`, `f=0.85`, bankroll **$7.32** (up from $7.27 — it won again), **196W/1L** (197 settled), drawdown brake inactive, no open/pending, `lastError=""`, `tradeReady.ok=true sigType=3`.
- Achieved fills: **24.3/day over 8.06d total; recent stable ~17/day** (06-16..06-19: 9,18,19,23). ENTRY count already nets out rejections, so ~17/day is the honest post-rejection rate.
- Mean entry ask **0.9862** (163/196 = 83% at 0.99). Per-win edge ≈ **0.8–1.05%/win** on bankroll (0.99-pure is ~0.80%; blended w/ the ~17% cheaper early fills is ~1.05%). Real number sits between — projections below show both ends via the 12/17/23 fan.

### Order-fill / liquidity reality (the operator's recurring concern) — VERIFIED
- Ledger has **279 LIVE_ORDER_REJECTED** vs 196 ENTRY. Deduped by cycle (epoch): **124 reject-only cycles** → true per-cycle fill ≈ **61%** (live-only ≈ 44%).
- Rejection causes: **114 FOK NO_FILL** (winner-side ask vanished near close — the hub B8/B12 effect, real), **134 "not enough balance/allowance"** (mostly same-epoch retry-spam at low bankroll), **31 API-key signer-mismatch** (historical, June-14 funder `0x3d21…`, since fixed).
- IMPORTANT: rejections do NOT reduce the achieved rate below ~17/day — that rate IS measured from actual ENTRY fills. The rejection rate matters because it caps how fast fills/day can scale (you cannot force ~17→40/day; the market simply doesn't fill the other signals).

### FOK vs FAK / "fill and kill" rereview (2026-06-20 19:20 local) — DO NOT change SNIPE yet
- Code truth: SNIPE hard-codes `orderType: 'FOK'` in `lib/snipe-strategy.js` for the initial live entry and the balance-aware resized retry. The global `CLOB_ORDER_TYPE=FAK` default in `lib/config.js` is NOT used by SNIPE, and changing a Polymarket website preference will not alter this bot path unless the code/env path is changed.
- Primary doc truth: Polymarket order docs define `FOK` as immediate all-or-nothing execution and `FAK` as immediate partial-fill execution with the rest cancelled. So FAK could only recover cases where there is **some** live depth but less than the requested share size; it cannot fix true zero-depth/no-fill cases.
- Ledger truth: all 279 `LIVE_ORDER_REJECTED` records have `matchedShares=0`; there is no observed rejected partial-fill that FOK killed. The major rejection buckets are signer-key historical errors, zero-fill/no-fill, and low-balance/allowance retry spam. This means **there is no primary evidence yet that FAK would have converted missed SNIPE cycles into profitable fills**.
- Risk truth: FAK partial fills below the bot's intended sizing can reduce per-fill profit and complicate accounting, but it does not reduce directional-loss probability. At the current bankroll, a 5-share minimum still dominates strand risk; accepting tiny partials would not materially improve the $7→$36.7 danger zone unless they are at least 5 shares and frequent, which the ledger has not proven.
- Recommendation: keep SNIPE on FOK now. Only test FAK as **paper/shadow instrumentation first**: on every FOK no-fill candidate, record refreshed depth at/under ask cap and calculate whether a FAK order would have filled ≥5 shares. Switch live only if forward data proves a real ≥5-share conversion rate without worse ask/slippage or accounting risk.

### Loss mitigation — does it stop the one loss? YES, with one residual flagged.
- The single live loss was **BTC 1h, entered tLeft=600**, a synchronized cross-asset whipsaw (hub F1).
- Deployed fix (verified in code today): `lib/snipe-strategy.js` L992 `deepMax 1h=120` (1h only fires in last 2 min) + L1003 `15m minBps=25/15`. Backtest: 1h tLeft≤120 = 1257W/0L; 15m bps≥25 = 6134W/0L; combined **7391W/0L** over 30d.
- The exact loss mechanism (1h entry at tLeft 400s) is now structurally impossible.
- **RESIDUAL VECTORS (honest):** (1) 1h deep `minBps` is still **20** (not 25) at tLeft 60–120 — backtest shows 0 losses there so not changed, but it is the one window not bps-hardened; monitor. (2) **K=2** (now live) removes the single-slot whipsaw cap (hub F4): above ~$39 two concurrent positions can both lose in one whipsaw cluster (~p² but non-zero). (3) Backtest≠live (hub A3): 0/7391 ⇒ Bayesian loss rate ~0.014%, 95% CI upper ~0.05%.

### The irreducible bust/strand truth at $7 start
- A loss takes the position to 0 ⇒ `B_new = B*(1-f) = 0.15·B`. To survive a loss AND stay above the $5.50 floor needs **B ≥ $36.7**. Below that, **ONE loss = strand**, and lowering `f` does NOT help (the 5-share ~$4.99 minimum already forces ~68% of a $7 bankroll in regardless of f).
- Danger zone = climbing $7.32→$36.7 ≈ **156 fills (~9 days at 17/day)**. P(strand) over that zone:
  | loss rate | P(strand) |
  |---|---|
  | 0.03% (Bayesian) | **4.6%** |
  | 0.05% (CI upper) | 7.5% |
  | 0.10% | 14.5% |
  | 0.20% | 26.8% |
- So at the loss rate consistent with the 0-loss backtest, **~3–8% bust risk**, concentrated in days 1–9. After ~$37 a single loss is survivable. This residual cannot be engineered to zero from $7 without a deposit (operator declined) — it is structural, not a strategy flaw.

### Honest day-by-day (deterministic 0-loss; real ask×depth expectation; start $7.32)
Full 180-day table: `scripts/v36-perf-review-daybyday.csv`. Script: `scripts/v36-perf-review.js`.
| Day | Conserv. 12/d (≈z≥4) | Base 17/d (deployed) | Optimistic 23/d (≈z≥2.5) |
|---:|---:|---:|---:|
| 1 | $8.27 | $8.72 | $9.27 |
| 7 | $17.44 | $25.09 | $38.66 |
| 14 | $41.53 | $83.42 | $175.09 |
| 16 | $52.98 | **$114.49** | $247.99 |
| 21 | $95.26 | $228.93 | $520.49 |
| 30 | $234 | $607 | $1,442 |
| 60 | $1,627 | $4,075 | $7,930 |
| 90 | $4,670 | $9,629 | $15,756 |
| 180 | $16,778 | $26,991 | $39,246 |
- **Time to $100 profit ($107 bal): 12 days (opt) / 16 days (base) / 23 days (conserv).** $100 in 7 days remains impossible from $7 (needs ~45–60 fills/day; getting ~17–24).
- Liquidity caveat (re-affirmed): exponential until median fill caps at **B≈$177**, fully linear by **B≈$3,425**; plateau ≈$339–458/day is a BTC-deep-book UPPER BOUND (those books vanish ~76% near close). Treat all >$3k figures as optimistic ceilings, not promises.

### Can we go faster while keeping bust minimal? Honest answer: NO free lever exists.
- More fills/day: signal-rate-bound (~17–24); cannot force. Lower z (→23/d) raises bust (1 backtest loss reappears).
- Lower f: does not reduce bust at $7 (min-order floor dominates) and slows growth.
- K=2: inert below ~$39; above it adds double-loss strand risk. No near-term speed gain.
- New/parallel strategies: all re-killed previously (cross-asset, perps, buy-every-cycle, maker, 5m, streak) — none additive.
- Conclusion: the **deployed config is the speed/safety optimum from $7**. Best honest expectation: **$100 profit in ~16 days at ~3–8% bust risk.**

---

## 13E. V36 SESSION (2026-06-20 PM): 1h-bps decision, env verification, portable backup, repo cleanup

### 1h deep `minBps` 20→25? — INVESTIGATED, KEEP AT 20 (no change).
- Question: would hardening the one un-hardened window cost profit? Answer: YES → do NOT change.
- Live-ledger evidence (`scripts/fly-snipe-ledger.jsonl`, 196 ENTRY): of the 4 historical 1h fills inside the CURRENT window (tLeft 60–120), **3 had bps 20–24 and ALL 3 were WINS**; there are **0 losses anywhere in the 1h tLeft≤120 / bps 20–24 band** (and 0 losses in the whole 1257-signal tLeft≤120 backtest). Raising the floor to 25 would therefore only drop ~75% of in-window 1h fills (all winners) while preventing zero observed losses → strictly profit-negative. Line 1003 stays `1h:20`.

### Fly env / secrets verification — ALL CORRECT.
- `fly secrets list` returned **98 secrets, all "Deployed"**; live `/api/status` effective values match intent: `LIVE`, `K=2`, `f=0.85`, `TFs=15m,1h`, `SNIPE_PAPER_MODE=false`, drawdown brake inactive, `tradeReady sigType=3`, funder `0x49756…6e97`.
- Authoritative secret file = `deploy-backup/.env.secrets` (its `POLYMARKET_ADDRESS` = the live funder). **`POLYPROPHET.env` is STALE** — it holds a DIFFERENT/old private key (`…dbede7`); do not use it.

### Portable full backup — CREATED at `..\POLYPROPHET_FULL_BACKUP_20260620\`.
- `app/` = complete deployable code (37 MB; server.js, lib/, public/, strategies/, scripts/, package*, Dockerfile, fly.toml, whitelisted debug strategy-sets). Excludes node_modules (regenerated by `npm ci`), the 48 GB local `data/`, 935 MB `debug/`, `.git`, and `audit_v*` snapshots (not needed to run).
- `SECRETS/fly-secrets.env` (8 sensitive secrets w/ REAL values + `PEAK_DRAWDOWN_BRAKE_MIN_BANKROLL=50`, `SNIPE_PAPER_MODE=false`), `SECRETS/set-fly-secrets.ps1` (one-shot `fly secrets import`), `SECRETS/deployed-secrets-names-digests.txt` (full 98 reference), `RESTORE.md` (new-PC / new-account switchover guide; wallet continuity + auto-derived CLOB creds explained). USB-ready.

### Repo cleanup — marked in `CLEANUP_CANDIDATES.md` (marking only; nothing destructive auto-run).
- Tier 1 safe-to-delete ≈ **49.5 GB** (local `data/` 48 GB, `debug/` 935 MB, `audit_v*` 221 MB, `node_modules` 110 MB, `external/`, `telegram_ai_media_bot/`, `local_archive/`, stale `POLYPROPHET.env`, scratch tmp files). Tier 2 review-first; Tier 3 = essential keep set. Derived from `.dockerignore` (the precise deployable footprint).

### No trading-logic/config change this session → no deploy needed.

---

## 13F. CRITICAL CORRECTION (2026-06-21 ~05:40Z): the tightening cut the live fill rate to ~4/day, NOT 17-24/day

**Trigger**: operator noticed the bot had not traded since ~19:03Z 06-20 (10.5h drought) and questioned the 17-24 fills/day projection. Investigation (live API + `/data/snipe/ledger.jsonl` pulled live → `scripts/live-ledger.jsonl`) revealed a Rule-Zero error in §13D.

**Bot health**: 100% fine — `isLive`, `mode=LIVE`, heartbeats every 60s, 17/18 markets active, `Candidates:0`, no errors, no halt, no pause, brake off. The drought is "no signal fired," not a fault (ledger had ZERO new ENTRY *or* REJECTED records since 19:03Z, so it isn't a fill/reject failure either).

**The real cause — over-tightening (quantified)**: Of 101 historical LIVE fills, only **23 (22.8%) would pass the DEPLOYED gate** (`scripts/v36-gate-survival.js`) → implied **~3.9 fills/day**, not 17-24. Two culprits:
- **1h `deepMax=120`** killed 38/42 (90%) of 1h fills — but this is JUSTIFIED: 1h fired almost entirely at tLeft 330-600, which is exactly where the only live loss (BTC 1h, `tLeft=600`) and all 6 backtest losses occurred. 1h was also marginal-EV (41W/1L≈97.6% vs 99.07% breakeven at 0.99). **Kept tight.**
- **15m FINAL bps floor raised 10→15** killed ~34 fills — and this was UNJUSTIFIED: the live record is **197W/1L with the sole loss on 1h**, so every one of those killed 15m final-window fills (bps 10-15) was a WINNER. Raising the final floor prevented **ZERO** losses while removing ~40% of volume. (The 3 backtest losses that motivated the bps change all had bps **20-24 in the DEEP window** — addressed by the deep floor=25, which stays.)

**FIX DEPLOYED (this session)**: `lib/snipe-strategy.js` — 15m FINAL bps floor reverted **15→10** (deep stays 25; 1h deepMax stays 120). Survival rises to **57/101 (56%) → ~9.7 fills/day** (`scripts/v36-gate-survival.js`, PROPOSED A). Zero added loss risk (all recovered fills are historical winners). `node --check` passed; deployed; verified live (`enabled`, f=0.85, K=2, no errors, brake off).

**Honest revised timeline** (0.93%/fill compounding, start ~$11.72):
- ~4/day (old deployed) → **~75 days** to $100 profit
- **~10/day (now) → ~25-29 days** to $100 profit
- ~17/day (pre-tighten, but reintroduces the 1h loss + 3 backtest losses) → ~17 days
The §13D table (17/24/day → $100 by day 16) is **superseded** — it used the PRE-tightening rate and never accounted for the deployed gate's true survival fraction.

**Balance reconciliation (verified, not assumed)**: post-restart the bankroll read **$11.72**, up from the accounting figure $7.38. This is REAL on-chain USDC — `clobCollateralUsdc=11.719816`, `balanceRaw=11719816`, and all signer candidates agree. The internal accounting bankroll ($7.38) had drifted BELOW the true wallet balance; the restart reconciled sizing UP to the on-chain truth (`sizingSource=live-cached-wallet`). Net positive: more capital, closer to the $36.7 single-loss-survival threshold, lower bust risk.

---

## 13G. FORENSIC AUTO-AUDIT (2026-06-21) — the permanent anti-inconsistency tool

**Why it exists**: every past pass claimed a fill rate (24 → 17 → 4 → 10 /day) that later turned out wrong. The root cause was reviews built timelines on the *historical* fill rate without ever asking "would the CURRENTLY-DEPLOYED gate actually still admit those fills?". `scripts/v36-forensic-audit.js` makes that mistake structurally impossible.

**What it does (single self-contained script, exit 0 = OK, 1 = critical fail):**
- **A. Derives the gate constants directly FROM `lib/snipe-strategy.js` source** (regex-parses `deepMax`, `deepMin`, `tMax`, `minBps`, `z`, `askCap`, depth, `snipeTries`). No hard-coded "expected" values that can silently drift. If it can't parse, that's a FAIL — we never certify a gate we can't read.
- **B. Pulls live runtime (`/api/status`, `/api/clob-status`, `/api/diagnostics`) and asserts code == runtime**: isLive, mode=LIVE, enabled, paperMode=false, brake inactive, tradeReady sigType, halt state, bankroll/f/K.
- **C. Re-computes the REAL fill rate from the actual ledger** AND runs the critical cross-check: of historical live fills, how many would the *current* parsed gate still admit (survival %). It prints **OBSERVED** (historical) and **PROJECTED** (historical × survival) as separate, clearly-labelled numbers, and WARNs whenever the gate cuts the historical rate by >20% (so no timeline is ever built on a stale rate again).
- **D. Honest bust/strand/profit math** from the live bankroll, verified 0.93%/fill edge, the $36.7 single-loss-survival threshold, and a strand-probability table across loss-rate assumptions.
- **E. README-hub trap checks** (projection-vs-survival gap, Trap A3 live loss-rate CI, Trap B8/B12 FOK no-fills).

**Re-run anytime:** `node scripts/v36-forensic-audit.js` (add `--no-live` to skip API). Latest output saved at `scripts/v36-forensic-audit-output.txt`.

**Verified findings this pass (2026-06-21, all primary-source):**
- Gate parsed = `{deepMax 15m=300/1h=120, deepMin1h=60, bpsDeep 15m=25/1h=20, bpsFinal 15m=10/other=20, z=3, askCap deep1h=0.99/deepOther=0.97/final=0.99, minDepth=5}`. 1h deepMax=120 (loss-mitigation) and z≥3 (break-even guard) both intact → **PASS**.
- Live runtime parity: `isLive=true, mode=LIVE, enabled=true, paperMode=false, brake inactive, tradeReady sigType=3, bankroll=$11.77, f=0.85, K=2, halt=false` → **PASS**.
- **Self-caught audit bug (Rule Zero in action):** an initial dedup by `id` showed "2 live losses"; investigation proved both `win=false` rows are the SAME BTC 1h loss (epoch 1781870400) — a PENDING row (no `id`) plus its RECONCILED row (with `id`). Fixed dedup to key on `asset:tf:epoch` across all reconcile types → **1 live loss**, matching the API's 197W/1L. Live-settled subset = **98W/1L** (the 197 headline includes paper SETTLEs).
- **Fill rate (the headline correction):** OBSERVED historical = **17.2/full-day**; current gate survival of historical fills = **57/101 = 56.4%** (killed: 38 by the 1h tLeft>120 window, 6 by 15m bps, 0 by z) → **PROJECTED ~9.7/day under the deployed gate**. This is a PROJECTION, not yet observed under the new gate — needs ≥24h live forward data to confirm.
- **Honest timeline** (start $11.77, 0.93%/fill compounding): ~9.7/day → **+$100 in ~26 days**; 17.2/day (only if the 1h-loss window were reopened) → ~15 days. **$100 in 7 days is impossible** from this bankroll (needs ~45-60 fills/day).
- **Strand risk** in the $11.77→$36.7 danger zone (~123 fills / ~12.7 days): 3.6% @ 0.03% loss-rate, 6.0% @ 0.05%, 11.6% @ 0.10%. Live loss-rate 95% CI upper = **2.84%** on 99 live settled.
- Verdict: **14 PASS, 4 WARN, 0 FAIL.** The 4 WARNs are the honest, human-judgement items (PROJECTED ≠ OBSERVED fill rate, gate cuts rate >20%, $100/7d impossible) — not faults.

**Strategy conclusion (re-verified, unchanged):** the deployed config (15m deep bps≥25/final≥10, 1h deep-only deepMax=120, z≥3, K=2, f=0.85, FOK) is the speed-vs-safety optimum from this bankroll. The only lever that raises fills materially (reopening the 1h tLeft>120 window) reintroduces the exact mechanism of the single live loss, so it is rejected. No code/config change was justified this pass — only the audit tool + documentation were added.

---

## 13H. DEEP FORENSIC RE-AUDIT + ALWAYS-ON DATA RECORDER (2026-06-21b)



This pass answered the operator's two demands: (1) the audit must cover **everything**

(manual line-by-line, not just a script — "things slip past scripts"), pulling the

trap checklist forward from the hub; and (2) stand up a forward collector that records

**everything every second**, **compresses itself**, runs in the **background**, and

**auto-starts on restart**. No trading-logic or config change was made or deployed.



### A) Manual, line-by-line forensic read of the live trading path (primary source = `lib/snipe-strategy.js`)

Every constant below was read directly from the deployed source and the numbers match

the live runtime (`/api/status`) and the real ledger 1:1.



- **Signal gate (lines 931-1047)** — per-second sigma accumulation (`c.n`, one sample/sec),

  pre-gates `c.n >= 60` (needs >=60s of samples), `c.spot0 != null`, `snipeTries < 120`.

  Window: `deepMax = 15m?300 : 1h?120 : 120`, `deepMin = 1h?60 : tMax(60)`,

  `inFinal` only for non-1h at `tLeft 5..60`. bps floors `inDeep ? (15m 25 / 1h 20 / 30) : (15m 10 / 20)`.

  `z = |d| / (sigma*sqrt(tLeft))`, gate `z >= 3`. askCap `inDeep ? (1h 0.99 / 0.97) : 0.99`,

  depth `bestAskSize >= 5`. **1h deepMax=120 and z>=3 are the two structural guards** and

  both are present.

- **Sizing (lines 349-353, 374-423, 639-643)** — `_sizingBankroll()` uses the **LIVE wallet

  balance** when not paper, accounting bankroll only as fallback. `rawShares = floor(B*f/(ask+FEE))`,

  `shares = min(rawShares, floor(depth))`, must be `>=5` and `cost <= B`.

- **Strand guard (lines 439-447)** — `_guardedFraction` lowers f so `B*(1-f) >= 5*(0.99+FEE)/f`

  **only when** the reduced stake still buys >=5 shares; otherwise returns the requested f

  (so at low bankroll nothing is both tradeable and one-loss-proof — this is the math, not a flaw).

- **Execution (lines 602-707)** — same-tick `_entryInFlight` lock + per-cycle dedup +

  `openSnipes >= maxConcurrent (K)` cap; emergency stop halts new live entries when

  `bankroll < minBankrollFloor`; entry is a single **FOK** BUY with a balance-aware resized retry.

- **Verified constants**: `FEE(p) = 0.072*p*(1-p)` (=> 0.00071 at 0.99), `minBankrollFloor` default

  **5.5**, `stakeFraction` default **0.85**, `maxConcurrent <= 6`. Min 5-share order @0.99 = **$4.9536**;

  hence the single-loss-survivable bankroll ~**$36.7** and "one loss = strand below that" is exact.



### B) Live state at audit time (primary source = live API)

`isLive=true`, `mode=LIVE`, enabled, `paperMode=false`, drawdown brake inactive,

`tradeReady sigType=3`, **bankroll=$11.77** (`src=live-refreshed-wallet`), `f=0.85`, `K=2`,

TFs `15m,1h`, no halt. **OBSERVED 17.2 fills/full-day** historically; current-gate survival of

historical fills **57/101 = 56.4%** (38 killed by the 1h tLeft>120 window, 6 by 15m bps, 0 by z)

=> **PROJECTED ~9.7 fills/day** under the deployed gate. This is a PROJECTION; needs >=24h live

forward data under the current gate to become OBSERVED. Live loss-rate 95% CI upper = **2.84%** on

99 live-settled (1 live loss, the BTC 1h). $100 profit ~ day 26 at 9.7/day; **$100 in 7 days is

impossible** from this bankroll.



### C) Forensic auto-audit (`scripts/v36-forensic-audit.js`) — now covers EVERYTHING

Re-run anytime: `node scripts/v36-forensic-audit.js` (`--no-live` to skip the API). Latest saved at

`scripts/v36-forensic-audit-output.txt`. Sections: **A** gate parsed from source, **B** code-vs-live

runtime parity, **C** OBSERVED-vs-PROJECTED fill rate from the real ledger (the exact metric that was

wrong before), **D** honest bust/strand/profit math, **E** hub trap checks, **F** the data-recorder

subsystem, **G** forensic constants parsed from source + a printed 10-item MANUAL trap checklist to

verify by hand. Latest verdict: **22 PASS, 5 WARN, 0 FAIL** (the 5 WARNs are honest judgement items:

PROJECTED != OBSERVED, gate cuts rate >20%, $100/7d impossible — not faults).



### D) Always-on forward data recorder (background + per-second + self-compressing + auto-start)

- `scripts/forward-second-clob-collector.js` (existing, schema v2 = full depth ladder + spot, 1 snapshot/sec

  per active market, connection-loss resilient) was upgraded with **lossless end-of-day gzip compaction**:

  `gzipFileSync` (verify-then-delete) + `compactCompletedDays(keepDay)` run once at startup and on every

  UTC **day rollover**; the live day is never touched. Disable with `FORWARD_COLLECTOR_COMPRESS=0`.

  Measured ~20x compression on this data; round-trip verified lossless.

- `scripts/run-forward-collector-supervised.js` (existing) relaunches the child on crash.

- **`scripts/start-forward-collector.cmd`** — background launcher (all assets; 5m/15m/1h/4h; per-second; spot+compress on).

- **`scripts/install-collector-autostart.ps1` / `uninstall-collector-autostart.ps1`** — register/remove a

  Windows Scheduled Task (`POLYPROPHET-ForwardCollector`, **At-Logon**, restart-on-stop) so the recorder

  auto-starts on every PC restart. One command: `powershell -ExecutionPolicy Bypass -File scripts\install-collector-autostart.ps1`.

- `scripts/analyze-forward-second-clob.js` now reads **`.jsonl.gz` transparently** (walk + gunzip) so

  compaction never hides data from future investigation.

- **Hosting decision (Rule Zero safety):** run the recorder on an always-on box **separate from the Fly

  trading VM**. That VM is shared-1cpu/1GB and the snipe places orders in the final seconds before close;

  a 28-market/second recorder co-located would compete for the same event loop and could cost fills. The

  recorder is read-only and never imports the executor, so it is zero-risk when run off-box.




---

## 13I. PERMANENT MASTER AUDIT PROTOCOL ADDED (2026-06-21c)

This pass answered the operator's request to make the audit/investigation **style itself** permanent
and all-in-one, so he never has to re-state his recurring instructions. No trading-logic or config
change was made or deployed.

- **Added the `MASTER AUDIT & INVESTIGATION PROTOCOL` section at the very top of this README** (right
  after RULE ZERO, max visibility). It is a permanent imperative charter that consolidates EVERYTHING
  from every operator prompt and prior hub into one place: the recurring-failure diagnosis (the
  24→17→4→10/day inconsistency the operator had to catch), the **four standing mandates**
  (strategy/goal maxxing; truthful re-verified research incl. auditing the *methods* not just results;
  continuous search for a better/concurrent/new strategy; reverify past+present with premortem — "a
  ship with no holes"), the **deepest-level manual forensic method** (line-by-line read of the live
  trading path → cross-reference live runtime → recompute from the real ledger → **OBSERVED vs
  PROJECTED** discipline → honest math → trap sweep → script as backstop only), the **always-on local
  forward recorder** standing infra, the **standing strategy ledger**, and an **end-of-pass checklist**.
- **Wired it into both cold-start triggers** (Section 8, full + short) so any fresh AI is pointed to
  "do the protocol first."
- **Annotated `scripts/v36-forensic-audit.js`** header to declare it is a regression BACKSTOP only —
  the authoritative procedure is the manual master protocol (operator: "things slip past scripts").
- **Re-verified live + audit this pass (primary source):** `node scripts/v36-forensic-audit.js` exit 0,
  verdict 22 PASS / 5 WARN / 0 FAIL (the 5 WARNs are the honest judgement items, not faults);
  `isLive=true, mode=LIVE, paperMode=false, brake inactive (minBankroll=50), bankroll=$11.77
  (src=live-refreshed-wallet)`. OBSERVED 17.2 fills/full-day; PROJECTED ~9.7/day under the deployed
  gate (still needs ≥24h live forward data to become OBSERVED); $100-in-7-days remains impossible from
  this bankroll. `node --check` passes on the audit, collector, and analyzer scripts.

---

## 13J. COMPLETENESS SWEEP — IS EVERYTHING INCLUDED? (2026-06-21d)

This pass answered the operator's question: *"Are all points from previous audits, readmes, hubs,
prompts etc included? Make sure the audit/hub encapsulates everything."* Method: re-read the MASTER
AUDIT & INVESTIGATION PROTOCOL, Section 6 traps, Section 7 rules, the Section 8 cold-start triggers,
Section 14, and the `README_v29_CENTRAL_HUB.md` headers, then diffed every recurring operator
instruction (across all prior prompts) against the protocol. No trading-logic/config change; nothing
deployed.

**Gaps found and now closed (added to the protocol at the top of this README):**
- **Liquidity cap as a standing math item** — where/when the book stops filling our growing size,
  profit/fill and profit/day at the cap, and the realistic MAX (Method E(i)). The operator raised this
  repeatedly ("will orders actually fill / liquidity left in market"); it was in §13C/§13D findings but
  not in the permanent protocol.
- **Combined-portfolio AND individual-strategy profit** stated separately (Method E(ii)).
- **Day-by-day table to 6 months** as a named standing deliverable per config (Method E2).
- **24h test window / FAK shadow test allowed** as an explicit hard rule.
- **Ask the operator if unclear** as an explicit hard rule.
- **Repo-wide read scope** — "every single file" applies to anything in scope, not only the trading path.
- **Standing portable backup** requirement (USB-mirrored, clean switchover).
- **Don't-be-timid (Trap H3)** restated as a hard rule.
- **Hub §5A v1→v28 trap register** added to the Method F trap sweep (previously only Section 6 + 14).
- **A COVERAGE MAP table** added that lists every recurring operator point and where it is satisfied, so
  the answer to "is everything included?" is now self-evident and self-maintaining.

**Verdict:** with these additions, the protocol now encapsulates every recurring instruction located
across all prompts, READMEs (RULE ZERO, §6, §7, §8) and the central hub. Re-verified live this pass
(primary source, fresh `/api/status` pull): `isLive=true, mode=LIVE, enabled=true, paperMode=false,
manualPause=false, bankroll=$11.9246, settled=200` (up from $11.77/198-settled in §13I — it has won
twice more), consistent with §13H/§13I; no projection figure changed. The honest math is unchanged:
$100-in-7-days remains impossible from this bankroll; OBSERVED 17.2 fills/full-day historically,
PROJECTED ~9.7/day under the deployed gate (needs ≥24h live forward data to confirm).

---

## 13K. REPRESENTATIVENESS SWEEP + COLD-START TRIGGER DE-STALING (2026-06-21e)

This pass answered the operator's request: *"full scan over readme hub — even fix prompt trigger,
don't mention specific balance, say 10 usd. Make sure prompt trigger is representative, make sure
full readme hub is also representative as well … nothing else needs to be included about my
preferences, goals, the things I ask you to do in terms of your investigation … Look repo wide."*
No trading-logic or config change was made; nothing deployed. This is documentation-only.

**Why the trigger was not representative (verified by reading it):** Section 8's cold-start trigger
(and its duplicate in `AUDIT_INITIATION_BRIEF.md`) baked in stale specifics that contradicted both the
current live state and this project's own proven findings — it stated `176W/1L, bankroll $6.04 USDC`
and the goal as `$100+ profit in 7 days`, and listed dead-end "buy-every-cycle" as Priority 2. The
$6.04 / 176W-1L figures are a 2026-06-19 post-loss snapshot (long superseded); $100-in-7-days is
disproven from a single-digit bankroll (needs ~45-60 fills/day; market gives ~17-24, ~9.7 under the
deployed gate); buy-every-cycle is killed-with-evidence in the Standing Strategy Ledger.

**Changes made (repo-wide, representative + no hard-coded balance — operator said say "~$10 USD"):**
- **Section 8 cold-start trigger (full + short) rewritten:** no baked balance → "treat as ~$10 USD and
  ALWAYS re-pull `/api/status` for the exact figure; never trust a written balance." Goal restated
  honestly (MAX profit/fastest/min bust-strand-variance-loss; $100+ target is a multi-week path from
  ~$10, NOT 7 days, with the why). Priority order updated to the real current posture (1) max the
  current near-lossless SNIPE, (2) find a better/concurrent/new strategy any venue, (3) re-confirm the
  killed-strategy ledger — don't re-litigate without new data. Added the manual-forensic +
  code==live-runtime + OBSERVED-vs-PROJECTED + 1:1-translation rules and the "do the MASTER PROTOCOL
  first" pointer.
- **Section 7 rule 8** and **Section 12 handover #12**: de-staled from "$100/7d from $6" to the honest
  "MAX profit, fastest, min bust/strand; $100+ profit target — multi-week from ~$10, not 7 days."
- **Section 1** retitled "DATED POST-LOSS SNAPSHOT … re-pull before trusting" with a ⚠️ note that the
  table balance/W-L is STALE, tightened gates + K=2 are since deployed, bankroll is back in the
  low-double-digit (~$10) range, and the latest verified state is in the most recent §13x entry.
- **`AUDIT_INITIATION_BRIEF.md`** (sibling paste-ready brief): Mission balance "$6.04 USDC" → "~$10 USD,
  re-pull `/api/status`"; its own cold-start trigger rewritten to match Section 8; dates refreshed.
- **Top-of-file date** refreshed to 2026-06-21.

**Scope check (repo-wide):** searched the repo for the stale strings (`176W/1L`, `$6.04`). Remaining
hits are (a) legitimate HISTORICAL records of the loss event (Section 0 "WHAT HAPPENED", §3, §6 trap
A6/A7, §14, the v12 row) which should stay as history, and (b) the frozen
`POLYPROPHET_FULL_BACKUP_20260620\` snapshot — deliberately NOT edited (a point-in-time backup must
not be mutated). The live `README.md` root pointer line is a historical "POST-LOSS CRISIS HUB (v36, 19
Jun 2026)" banner and is left as the dated event marker it is.

**What I did NOT need to add:** the MASTER AUDIT & INVESTIGATION PROTOCOL (top) + COVERAGE MAP already
capture every recurring operator preference (no passive misinformation, deepest manual forensic read,
code==live, recompute from ledger, OBSERVED-vs-PROJECTED, strategy/goal maxxing, continuous
better/new-strategy search, liquidity cap, day-by-day table, combined-vs-individual profit, 24h test
window, ask-if-unclear, repo-wide scope, standing backup, don't-be-timid). I re-read them end to end
this pass and confirmed no recurring preference is missing; this entry just makes the *trigger and the
"current state" framing* consistent with that honest protocol.

**Backstop re-run this pass:** `node scripts/v36-forensic-audit.js` → exit 0, 22 PASS / 5 WARN / 0 FAIL
(WARNs are the standing honest-judgement items: projected ~9.71 fills/day not yet OBSERVED under the
current gate; benign `NO_FILL_AFTER_RETRIES` lastError; loss-rate CI-upper note). No code touched, so
the verdict is unchanged from §13I/§13J.

---

## 13L. FRESH MASTER-PROTOCOL RE-AUDIT + TWO RULE-ZERO CORRECTIONS (2026-06-21f)

This pass ran the MASTER AUDIT & INVESTIGATION PROTOCOL end-to-end from a cold start (operator re-issued the Section 8 trigger): Method A (manual char-by-char read of the live trading path) + B (live runtime cross-check) + C/D (recompute from the real ledger, OBSERVED vs PROJECTED) + E (honest math) + F (trap sweep + premortem) + G (backstop). One trading-file change: **comment-only** docstring de-staling (below). No gate/sizing/config logic changed; nothing deployed.

### Live state re-pulled (primary — `/api/status`, `/api/clob-status`, `/api/diagnostics`, `/api/health`, ~19:12Z)
`isLive=true, snipe.mode=LIVE, enabled=true, paperMode=false, manualPause=false, muted=false`. Bankroll **$12.259836** (live==sizing≈accounting $12.20; `sizingSource=live-refreshed-wallet`; identical across status/clob/health). `K(maxConcurrent)=2, f=0.85, fEff=0.5246 (guarded)`. `allowedTimeframes=[15m,1h]`. Drawdown brake **inactive** (`minBankroll=50`). CLOB `tradeReady.ok=true, sigType=3, funder=0x49756…6e97, closedOnly=false, balance=12.259836`. `tradeFailureHalt.halted=false`; orchestrator live (markets=17, candidates=0 = normal idle between cycles). `lastError=NO_FILL_AFTER_RETRIES` (benign FOK no-fill; `balanceAwareRetry` correctly SKIPPED it as `NON_BALANCE_ALLOWANCE_TRIGGER`).

### Code == live runtime (verified char-by-char this pass)
Gate parsed from `lib/snipe-strategy.js` == manual read == audit parse: `deepMax 15m=300 / 1h=120; deepMin1h=60; 1h is DEEP-ONLY (no final window); minBps deep 15m=25 / 1h=20, final 15m=10 / other=20; z≥3; askCap deep1h=0.99 / deepOther=0.97 / final=0.99; depth≥5; snipeTries<120; sigma n≥60`. Sizing: `_sizingBankroll()` uses the LIVE wallet; `_guardedFraction()` is applied at entry (proven by fEff=0.5246≠0.85). Execution: `_open`→`_openInner` places **FOK** at the signal ask; sub-5-share / cost>bankroll skipped; emergency stop refuses live entries when bankroll < floor $5.5.

### Ledger recompute (primary — `scripts/live-ledger.jsonl`, 3299 records)
ENTRY=198 (101 live); **live-settled 98W / 1L** (headline 197W/1L incl. paper). Live API now 202W/1L/203-settled (incl. paper SETTLEs; +5 wins / +5 settled since the 06:27 ledger pull). OBSERVED **17.2 fills/full-day** (06-15…06-19). Current-gate survival of historical live fills = **57/101 = 56.4%** (killed: window 38, bps 6, z 0) → **PROJECTED 9.71 fills/day** under the deployed gate *(PROJECTION, not yet OBSERVED under the tightened gate — needs ≥24h live forward data; standing OBSERVED-vs-PROJECTED discipline)*. FOK no-fill rejects: 279 (fillability wall; caps scale-up, does not lower the observed rate). The 2468 `LIVE_RECONCILE_PENDING` poll-duplicates confirm W/L must be **deduped by `asset:tf:epoch`** (naïve counting overcounts ~27×).

### ⚠️ RULE-ZERO CORRECTION #1 — the single live loss entered at tLeft=600 (not "~400") and cost −$29.7214
Primary-source loss record (epoch 1781870400 — the only `win:false` trade; it appears twice, PENDING + RECONCILED = **one** loss): `BTC 1h, side=down, outcome=up, shares=30 @ ask 0.99, capDepth=500.1, guarded f=0.83702, sig.bps=38.64, sig.z=3.11, sig.tLeft=600, cost=$29.7214, pnl=−$29.7214, liveBalanceAtSizing=$35.757303 → liveBankrollAfter=$6.036513`. §0/§13D/§13F/§13H variously say "tLeft≈400" and "~$29.45 / $35.487393→$6.036513"; the **primary figures supersede those**: tLeft=**600**, pnl=**−$29.7214**, pre=**$35.7573**. Conclusion unchanged (both 600 and 400 exceed `deepMax=120`, so the deployed 1h restriction still removes this exact entry).

### ⚠️ RULE-ZERO CORRECTION #2 — the strand guard makes the true single-loss-survival threshold ≈$10.78, not $36.7
Live `fEff=0.5246` proves `_guardedFraction()` is active. Re-derived char-by-char: `minTradeable = 5·(0.99+FEE(0.99))/f = 4.95356/0.85 = $5.8277; fGuard = 1 − minTradeable/B`, applied iff `0 < fGuard < f` **and** the guarded stake still buys ≥5 shares (`B·fGuard ≥ $4.954`) — which holds for **B ≥ ~$10.78**. In `$10.78 ≤ B ≤ ~$38.85` the guard pins post-loss bankroll to `B·(1−fGuard) = $5.83` — above the $5.50 floor and still tradeable. So at the current **$12.26, ONE loss is survivable** (→ ~$5.83), not a strand. §13D and the audit's `survivable=36.7` use the **unguarded** f=0.85 (`post-loss=0.15·B`); $36.7 is the "fully one-loss-proof at full f" ceiling, **not** the strand point. **Honest caveat (not timidity):** after that first loss you sit at ~$5.83 < $10.78 where the guard can no longer help, so a *second* loss before you climb back above ~$10.78 (≈100 wins near the floor) busts you. Net: **bust needs ~2 losses, so the §13D/audit P(strand) table (3.5% / 5.8% / 11.2% / 21.2% at loss-rate 0.03–0.20%) is a CONSERVATIVE UPPER BOUND**; real near-term bust risk is lower, but the post-first-loss period is slow and fragile. No config change recommended — the guard is doing its job.

### Honest math (re-confirmed)
Per-fill edge ≈0.93% of cost. To **+$100 profit**: ≈**25 days @ 9.71 PROJECTED fills/day**, ≈14 days @ 17.2 OBSERVED. **$100 in 7 days is impossible** from ~$10 (needs ~45–60 fills/day; market supplies ~17 historically, ~9.7 under the gate). Live loss-rate 95% CI upper = 2.84% on 99 live-settled — but the sole loss is now gated out (tLeft 600>120), so the forward rate for the deployed gate is better bounded by backtest (1h tLeft 60–120 = 1257W/0L; every live 15m fill to date was a win). **Liquidity cap & combined-vs-individual (re-confirmed from §13C line 637 + protocol Method E, no new liquidity mining this pass):** with median ledger cap-depth 152, position size becomes liquidity-capped around **B≈$177** (`152·0.990713/0.85`), growth turning linear rather than exponential and fully liquidity-linear by ~$3,425 (Method E). These are *upper bounds* — deep BTC books vanish ~76% near close. I did **not** re-derive the exact $/day-at-cap this pass (no new tape mining inside the 24h window), so no profit/day-at-cap figure is asserted here; at the current ~$12 bankroll liquidity easily covers the 5–6-share order, so the binding near-term constraint is fills/day + loss risk, not depth. Only SNIPE clears the 99.07% break-even, so combined-portfolio profit == individual SNIPE profit today.

### Strategy search (Mandate 3) — no new deployable edge this pass (honest)
Re-confirmed the Standing Strategy Ledger from existing evidence (no new data to overturn): cross-asset momentum, Hyperliquid perps, buy-every-cycle@0.45, wider-z gates, maker-limit (≈ the existing ~0.5/day deep fills), streak-reversal (0 fills ever), 5m (~1.2/day) — all remain killed / EV≤0. The only NON-killed avenues remain evidence-gated and not deployable now: a **FAK shadow** instrumentation test and **maker/limit** (v33 3W/0L proxy, queue-uncertain), both pending ≥24h forward evidence. "Mathematically impossible" is NOT claimed; no fabricated edge is reported (RULE ZERO).

### Trading-file change this pass — comment-only docstring de-staling (zero logic)
The `lib/snipe-strategy.js` header docstring still described the *pre-v36* gate (a "comment says X, code does Y" trap): `15m deep bps ≥ 20` (runtime 25), `1h (60,600]` (runtime deepMax 120), and "ONE open snipe globally; f=0.85 flat" (runtime K=2, fEff guarded). The deployed **runtime** was already correct (verified from the API); only the comment was stale. Fixed in place (no line shift): bps→`25/30`, 1h→`(60,120]`, posture line→`up to K open snipes (default 1, live K=2); f=0.85 nominal, reduced by _guardedFraction() at low bankroll`. `node --check` → OK; audit gate-parse unchanged (its regexes read code, not comments). Not deployed (a comment needs no deploy; ships on the next deploy).

### Forward recorder — NOT running in this workspace (flag for operator)
In this checkout there is no `data\forward-second-clob\` directory, no snapshots in the last 6h, and no collector process. If this is **not** the operator's always-on PC, that is expected (the per-second tape lives on the separate always-on box, never on the Fly trading VM). **Action for operator:** confirm the recorder is running + daily-compressing on the always-on PC; if this checkout *is* that box, run `powershell -ExecutionPolicy Bypass -File scripts/install-collector-autostart.ps1`. (No throwaway collector was started in this transient session — it would die at session end and add no data.)

### Premortem + trap sweep + new trap
Premortem ("assume the bankroll busted in 2 weeks — cause?"): the realistic cause is **two losses in quick succession while in the $5.83–$10.78 no-guard band** (one loss alone is survivable). The deployed gate removes the only observed loss mechanism (1h tLeft>120) and 15m has never lost live; the residual risk is a *new* 15m-deep reversal, bounded by z≥3 / bps≥25 / ask≤0.97. Walked Section 6 + the audit's 10-item checklist — none triggered. **New trap added (H7):** *stale in-code docstring gate values* — a manual reader trusting the `snipe-strategy.js` header would have mis-stated the live gate; comments must be swept against the code every pass, not just the README.

### Backstop
`node scripts/v36-forensic-audit.js` → exit 0, **22 PASS / 5 WARN / 0 FAIL** (WARNs = standing honest-judgement items: PROJECTED 9.71 ≠ OBSERVED until ≥24h live data; benign NO_FILL lastError; gate keeps 56% of historical rate; loss-rate CI note; $100/7d impossible). Output saved to `scripts/v36-forensic-audit-output.txt`.

---

## 13M. FRESH LEDGER RE-PULL + COMMENT TRAP FIX + RECORDER BLOCKER (2026-06-21g, ~20:33Z)

This pass re-ran the MASTER AUDIT & INVESTIGATION PROTOCOL from the Section 8 trigger. Manual live-path read covered `lib/snipe-strategy.js`, `lib/trade-executor.js`, `lib/clob-client.js`, `lib/risk-manager.js`, `server.js`, and `lib/config.js`; live API parity was pulled from `/api/status`, `/api/clob-status`, `/api/diagnostics`, and `/api/health`; the real Fly ledger was re-pulled; `README_v29_CENTRAL_HUB.md` §5A was skimmed for v1-v28 traps. No trading logic/config was changed; no deploy was made.

### Live state re-pulled (primary API, ~20:25Z)
`isLive=true`, health `ok`, `snipe.mode=LIVE`, `enabled=true`, `paperMode=false`, `manualPause=false`, no pending buys/sells/settlements/recovery/redemption queues, no error halt/trade-failure halt. Bankroll / CLOB collateral / sizing balance = **$12.259836 USDC**. CLOB `tradeReady.ok=true`, `sigType=3`, funder `0x49756ECdA82F999EfB75F93f8B70a0Ff4Ea36e97`, `closedOnly=false`, balance `12.259836`. SNIPE status from API: **202W / 1L / 203 settled**, `fEff=0.5246`, `allowedTimeframes=[15m,1h]`, last error `NO_FILL_AFTER_RETRIES` (benign FOK no-fill). Some API fields still surface as `null` (`K`, `cap`, `floor`, `minShares`, `ledgerPath`), so this pass verified those from source + audit parse instead of assuming the status JSON is complete.

### Fresh ledger recompute (primary Fly `/data/snipe/ledger.jsonl`, copied into `scripts/live-ledger.jsonl`)
Important Rule-Zero correction inside this pass: the first audit run used an existing local ledger. I then fetched a fresh Fly copy (`scripts/live-ledger-fresh-20260621-2031.jsonl`), copied it over `scripts/live-ledger.jsonl`, and reran the audit. Fresh ledger stats now supersede the earlier local-ledger run: **3324 records**, ENTRY **203 total / 106 live**, live-settled dedup **103W / 1L**, sole live loss `BTC 1h tLeft=600 pnl=-29.7214`. Per-day live fills: `2026-06-14=12`, `06-15=17`, `06-16=9`, `06-17=18`, `06-18=19`, `06-19=23`, `06-20=3`, `06-21=5` so far. OBSERVED full-day live fill rate (06-15..06-20, now including the post-tightening 3-fill day) = **14.83/day**. Current-gate survival of historical live fills = **62/106 = 58.5%** (`window=38`, `bps=6`, `z=0` killed) → **PROJECTED 8.68 fills/day** under the current deployed gate. This is a PROJECTION, not yet a 24h observed forward rate.

### Honest performance/risk update
Per-fill edge remains ≈**0.93% of cost**. Starting from live bankroll **$12.26**, audit math gives `+$100` at about **28 days @ 8.68 PROJECTED fills/day**, **24 days @ 10/day**, or **17 days @ 14.83 OBSERVED historical/day**. `$100 in 7 days` remains impossible from this bankroll without ~45-60 fills/day; fresh ledger now says the historical market supplied ~15/day, and the deployed gate projects ~8.7/day. Live loss-rate 95% CI upper improved slightly to **2.71% on 104 live settled**, but this mixes pre-tightening exposure with the current gate; the single observed loss remains a `tLeft=600` 1h entry that the `deepMax1h=120` gate blocks. One current-bankroll loss is survivable because the guard pins post-loss to about `$5.83`, but a second loss before rebuilding above the guard threshold remains the realistic bust path. Combined-portfolio profit still equals individual SNIPE profit because no other strategy currently clears the 99.07% break-even/live-transfer bar.

### Code/comment change (zero logic)
Fixed one remaining stale inline comment in `lib/snipe-strategy.js`: it said the live BTC 1h loss entered at `tLeft ~400s` and cost `~$29.45`; primary ledger says `tLeft=600` and `-$29.7214`. The comment now matches the primary ledger. This is the same H7 trap class as §13L: comments must be checked against code + ledger, not trusted.

### Forward recorder status (local infrastructure finding)
Checked this Windows checkout for the always-on local recorder: no `POLYPROPHET-ForwardCollector` Scheduled Task, no `data/forward-second-clob/<today>` directory, and no yesterday gzip/plain collector files. I attempted the standing installer command `powershell -ExecutionPolicy Bypass -File scripts\install-collector-autostart.ps1`; it resolved the correct launcher but failed at `Register-ScheduledTask` with **Access is denied**. This pass therefore could not make the recorder persistent from the current permission context. Operator action if this is the always-on PC: run the installer from a permission context allowed to create the user Scheduled Task, or manually start `scripts\start-forward-collector.cmd` and verify today snapshots + yesterday compression. This is a blocker for future 24h forward evidence, not a live-trading blocker.

### Strategy / trap sweep result
No deployable better/concurrent edge was found from evidence available in this pass. Reconfirmed the killed-with-evidence ledger without relitigating from scratch: cross-asset momentum, Hyperliquid shared-signal perps, buy-every-cycle cheap asks, wider-z gates, maker-limit as live-uncertain, streak reversal, and 5m still do not beat SNIPE on live-transfer/break-even evidence. Non-killed next evidence items remain: get the forward recorder running, then use ≥24h fresh tape to reassess maker/FAK/shadow and any earlier-entry variants. Premortem remains: bankroll failure in the next two weeks would most likely require two losses close together while in the low-bankroll guard/no-guard band, or a new 15m reversal mechanism not present in the historical/live ledger.

### Verification
- `node --check lib\snipe-strategy.js` → OK.
- `node scripts\v36-forensic-audit.js | Tee-Object -FilePath scripts\v36-forensic-audit-output.txt` → exit 0, **22 PASS / 5 WARN / 0 FAIL**. WARNs are the expected honest-judgement items: benign `NO_FILL_AFTER_RETRIES`, PROJECTED 8.68/day not yet observed, gate cuts historical rate >20%, projection trap warning, live loss-rate CI note / `$100 in 7 days` impossibility.

---

## 13N. POST-WITHDRAWAL STRAND FLIP + OBSERVED FILL-RATE COLLAPSE (2026-06-23, ~18:43Z)

> **TOP CORRECTION (authoritative; supersedes any "+$7.76 / ~$1.85/day / no deposit / all from 15m wins" wording later in THIS section, which was wallet-delta-confounded and is RETRACTED per RULE ZERO):**
> The bot's profit must be read from the ledger `pnl` field, NOT from wallet-balance differences (the free wallet swings with committed capital + external deposits/withdrawals).
> - **Realized live profit SINCE the loss = +$2.6944** (32 wins; avg **$0.0842/win**; daily 06-20 +$0.167, 06-21 +$0.548, 06-22 +$0.539, 06-23 +$0.493) ≈ **~$0.5/day**.
> - **All-time realized live PnL = −$15.90** (the single −$29.72 loss still dominates the lifetime record).
> - The wallet rose from $6.04 (post-loss free wallet) to $10.86 — i.e. +$7.77 once the $2.94 withdrawal is added back — which is **~$5 MORE than the bot earned (+$2.69)**. This is NOT necessarily a deposit and NOT an anomaly: the $6.04 figure was the FREE wallet, which EXCLUDED capital still locked in open positions at that instant; as those positions settled, the free wallet rose independently of new profit (visible as the +$4.40 balance step on 06-20→06-21). The equity identity `ΔEquity = realizedPnL + deposits − withdrawals` is satisfied with **$0 deposit IF ~$5 was committed/locked at the $6.04 snapshot**, so no deposit need be assumed. Either way the bot's realized post-loss earnings are **+$2.69, not +$7.77**; the only external flow visible in the ledger is the −$2.944 withdrawal. (Operator: if you also deposited post-loss, that is additional external capital, not profit.)
> - **Honest time-to-+$100:** at realized ~$0.5/day with compounding (~4.6%/day at this bankroll) and zero further losses/withdrawals, **≈ 5–7 weeks** (≈32 days ONLY if the fill rate recovers to the audit's 8/day). **$100 in 7 days remains impossible** (needs ~45–60 fills/day; market gives ~5–6 under the deployed gate).
> - **Profit/win** averages **$0.084** (range ~$0.05 at 5-share/0.99 to ~$0.17 at 9-share/0.98). The figures `~$0.09–$0.17` / `~$0.5–1.0/day` written below are superseded by this $0.084-avg / ~$0.5-day figure.

This pass re-ran the MASTER AUDIT & INVESTIGATION PROTOCOL from the Section 8 trigger to answer five operator questions: (1) can we get more fills within goals, (2) are we on track, (3) is reconciliation/balance-update timing hurting profit/frequency, (4) is more profit possible, (5) the operator withdrew "~2-3 usd the other day". Manual char-by-char read of `lib/snipe-strategy.js` (sizing/guard/reconcile/`status()`); live parity from `/api/status`, `/api/clob-status`, `/api/diagnostics`, `/api/health`, `/api/wallet/balance`; a FRESH Fly ledger was pulled via `fly ssh sftp get /data/snipe/ledger.jsonl` (→ `scripts/live-ledger-fresh-20260623.jsonl`, copied over `scripts/live-ledger.jsonl`). **No trading logic/config changed; nothing deployed (operator chose investigation-only).**

### Live state re-pulled (primary API, ~18:43Z) — deploy == runtime asserted via `fly status`
`isLive=true`, health `ok`, `snipe.mode=LIVE`, `enabled=true`, `paperMode=false`, `manualPause=false`, `muted=false`; all pending/recovery/redemption queues **empty**; no error/trade-failure halt; drawdown brake **inactive**. Bankroll / CLOB collateral / sizing balance = **$10.860617 USDC** (`sizingSource=live-refreshed-wallet`, `liveBalanceSource=CLOB_COLLATERAL_FALLBACK`, `baselineBankrollSource=external_balance_rebase` — i.e. the bot auto-detected the operator's withdrawal as an external balance change). CLOB `tradeReady.ok=true, sigType=3, funder=0x49756…6e97, closedOnly=false, balance=10.860617`. SNIPE API headline **214W / 1L / 215 settled** (incl. frozen historical paper SETTLEs), `fEff=0.4634`, `K=2`, `f=0.85`, `allowedTimeframes=[15m,1h]`, `lastError=NO_FILL_AFTER_RETRIES` (benign). `fly status`: app `polyprophet` machine `1857502a542408` `started`, image **`deployment-01KVMAMJAK4MB755WZF7W5BZFD`** == `/api/health` deployVersion → **deployed image == running runtime**. Gate parsed from source == audit parse == manual read: `deepMax 15m=300 / 1h=120; deepMin1h=60; minBps deep 15m=25 / 1h=20, final 15m=10 / other=20; z≥3; askCap deep1h=0.99 / deepOther=0.97 / final=0.99; depth≥5; FEE=0.072·p·(1−p); floor=$5.5`.

### Fresh ledger recompute (primary — `scripts/live-ledger.jsonl`, 3398 records)
ENTRY **215 total / 118 live** (97 frozen paper). Live-settled dedup by `asset:tf:epoch` = **115W / 1L** (was 103W/1L at §13M 06-21 → **+12 live settled in ~2 days ≈ 6/day**, corroborating the OBSERVED rate below). Sole live loss unchanged: **`BTC 1h tLeft=600 pnl=−$29.7214`** (15m has still NEVER lost live).

### ⚠️ RULE-ZERO FINDING — the −$2.944 withdrawal flipped the strand guard INERT; one loss now STRANDS
Question 5 has a consequence the operator must know (it supersedes §13L Correction #2's "$12.26 → one loss survivable" for the *current* balance). Withdrawal pinpointed from the ledger `liveBalanceAtSizing` path: a **−$2.944 step on 2026-06-22 between 06:14Z ($12.709) and 08:29Z ($9.764)** (prev trade cost was only $5.94, so the drop is external, not trading; no deposit anywhere in the recovery leg). That dropped the bankroll **below the strand-guard flip point (~$10.6–$10.78, ask-dependent)**. Re-derived `_guardedFraction()` char-by-char and replicated it source-exactly (`scripts/_pass_analysis.js`): below the flip the guarded 5-share stake would fall under the 5-share minimum, so the guard **falls back to full f=0.85** by design. VERIFIED from real ENTRY records: **every one of the 7 live entries from 06-22 08:29Z → 06-23 17:59Z** has `f=0.85`, **8–9 shares, 77–85% stake, `liveBalanceAtSizing` $9.76→$10.69, post-loss bankroll $1.6–$2.4** — i.e. **a single loss now strands the account far below the $5.50 floor** (vs the pre-withdrawal entries at $11.9–$12.7 which were guarded: f≈0.51–0.54, 6 shares, ~48% stake, post-loss ~$6, survivable). The current $10.86 is only **~$0.08 above the 0.99 flip ($10.781)** — it dips back into 85%/strand mode on any small fluctuation or further withdrawal. **`status().fEff` is hard-coded to ask=0.99 (line 231), so the displayed 0.4634 UNDERSTATES strand risk** for the ask≤0.98 entries that actually dominate. **Operator was informed and chose (this pass) to LEAVE IT AS-IS** — accept the single-loss strand tail-risk in exchange for ~2× profit/win (~$0.17 vs ~$0.09), relying on 15m's lossless live record. Logged as an explicit, informed operator trade-off (Trap H3: not timidity), NOT an undisclosed risk.

### Q1/Q2 — OBSERVED fill-rate COLLAPSE under the deployed gate (the honest "on track" answer)
Per-day LIVE fills (corrected sec→ms timestamps): `06-14=12, 06-15=17, 06-16=9, 06-17=18, 06-18=19, 06-19=23, 06-20=3, 06-21=7, 06-22=6, 06-23=4(partial)`. There is a clear **regime break at 06-20** (when the tightened gate + paper→live fix took full effect): pre-tightening averaged **~16/day mixed 15m+1h**; post-tightening is **~5–6/day and 15m-ONLY — the 1h gate (`deepMax=120`) has produced ZERO 1h fills since 06-19.** So OBSERVED current ≈ **5–6 fills/day** (last 24h=4, 48h=12, 72h=18). The forensic audit's **PROJECTED 8.0/day** applies the current gate to the *whole* 9-day history (62.7% survival; killed window=38, bps=6); the live 06-21→06-23 days are running *below* even that. **Both are below §13M's 8.68 projection and far below the discredited 17–24.** On-track math: net of the −$2.944 withdrawal the wallet went **$6.04 (post-loss 06-19) → ~$13.80 effective ≈ +$7.76 in ~4 days (~$1.85/day)**, all from 15m wins, zero further losses — working as intended but SLOW. At OBSERVED ~5–6/day, **+$100 profit ≈ 4–6 weeks** (audit: 32 days @8/day, 26 @10/day); **$100/7d remains impossible** (needs ~45–60 fills/day).

### Q3 — reconciliation / balance-update timing is NOT interfering (verified, not assumed)
- **Redemption is fast:** close→resolved latency median **2.4 min**, p90 2.9, max 7.5 (n=122 reconciled wins); `reconcileAttempts` median 1–2; the 15m cycle is 15 min, so won capital returns long before the next same-asset cycle. Diagnostics lifecycle log (06-22→06-23) shows `redemptionFailed:0` and `entriesBlocked:false` on every run; `redemptionQueueBlocksEntries:false`, `autoRedeemAuthReady:true`, all queues empty.
- **Sizing uses a FORCE-REFRESHED live wallet** at the moment of entry (`_sizingSnapshot()` → `refreshLiveBalance(true)`, `source=live-refreshed-wallet`), so entry sizing is never stale.
- **No fills lost to balance NOW:** of **326** `LIVE_ORDER_REJECTED`, the clean date-stamped partition (sums to 326) = **161 ask-vanished FOK no-fills** (ALL days incl. recent — the unavoidable near-close fillability wall), **31 signer/"maker not allowed" auth errors** (06-14 only, early funder `0x3d21…` setup), **58 "not enough balance"** (06-15:6, 06-17:52 — early funder/allowance setup), **59 "order manager not ready" (425)** + **17 post-only** (both 06-19 only — a transient CLOB outage that day). **CRUCIAL: every balance/auth/mgr/post-only reject is HISTORICAL (≤06-19); the ONLY reject type on 06-20→06-23 is the ask-vanished no-fill** (min `liveBalanceAtSizing` across the recent rejects that carry the field = **$5.87**, none below $5). So the 58 "not enough balance" rejects were a one-off early wallet/funder/allowance setup issue (resolved by 06-19), **NOT** redemption-timing, and nothing balance-related has rejected since 06-17. **Conclusion: the limiter on fills is the GATE + the near-close fillability wall, NOT reconciliation/balance timing.**

### Q4 — more profit / more fills, within goals (re-confirmed, honest)
**More fills:** the gate is the limiter, not asset count (already trades BTC/ETH/BNB/DOGE/XRP/SOL) and not reconciliation. The only levers that materially raise fills — reopen 1h `tLeft>120` (the exact mechanism of the single live loss), loosen 15m `bps<25`, lower `z<3` (drops below the 99.07% break-even), or raise `K` (inert <~$39, adds clustered double-loss risk) — **all reintroduce loss/strand risk and are rejected by the near-lossless goal** (Standing Strategy Ledger + audit checklist items 04/05/07 re-confirmed; killed ledger unchanged, no new data to overturn). **No within-goal lever materially raises fills.** **More profit:** at this bankroll profit/win is ~$0.09 (5-share guarded) to ~$0.17 (9-share inert) → ~$0.5–1.0/day; the 85%-staking the operator opted to keep already maximises profit/win. Real profit scaling needs **more bankroll** (liquidity cap ~B$177 per §13C is far above current size, so depth is not yet binding) — i.e. a deposit or compounding time, not a config tweak. **Mandate 3:** searched again, **no new deployable edge** found with evidence this pass.

### Premortem + traps + backstop
Premortem (bust in 2 weeks?): the realistic cause is now **a single 15m loss while in the post-withdrawal 85%-stake band** (operator-accepted) OR two losses close together in the $1.6–$10.78 no-guard band. Section 6 + audit 10-item checklist swept — none newly triggered. Refinement to §13L Correction #2: the ~$10.78 survivability threshold is **balance-AND-ask dependent and the displayed `fEff` (ask 0.99) hides the ask≤0.98 strand case** — verify both, not just `fEff`, every pass. `node scripts/v36-forensic-audit.js` → exit 0, **22 PASS / 5 WARN / 0 FAIL** (WARNs = standing honest-judgement items: PROJECTED 8.0/day not yet OBSERVED; benign `NO_FILL_AFTER_RETRIES`; gate cuts historical rate >20%; loss-rate CI; $100/7d impossible). Forward recorder: not running in this transient checkout (expected — it lives on the operator's always-on PC, never on the Fly trading VM); operator should confirm it is recording+compressing there.

---

## 13O. STAKE-SIZING (100% / DANGER-ZONE-100%) + FULL 5m RE-INVESTIGATION + FLOOR-AWARE GUARD BUILT (2026-06-23, ~21:10Z)

This pass re-ran the MASTER AUDIT & INVESTIGATION PROTOCOL for the operator's new questions: **Q1** raise stake to ~100% (or closer); **Q2** 100% while in the danger zone then less once escaped; **Q3** full 5m investigation (SNIPE-style AND a brand-new method, all assets); **Q4** anything new only after Q1–Q3 are exhausted (operator excluded Kalshi cross-venue). Manual char-by-char re-read of the `lib/snipe-strategy.js` sizing/guard path; fresh live pull (`/api/status|clob-status|wallet/balance|diagnostics|health`); fresh Fly ledger (`scripts/live-ledger.jsonl`, 3400 records); a LIVE Polymarket probe of current 5m+15m markets (`scripts/_probe_5m.js`); and ground-truth tape analyses (`scripts/_analyze_5m_intracycle.js`; `scripts/_analyze_5m_flip.js` over `data/binance-1s`; exact staking math in `scripts/_pass_stake_analysis.js`). **No trading logic/config changed; nothing deployed (awaiting operator decision below).**

### Live state (primary API, ~20:55Z) — guarded & survivable RIGHT NOW
$10.860617 USDC (status/clob/wallet agree), LIVE/enabled/not-paused/not-muted, brake inactive, 0 open, all queues empty, image `deployment-01KVMAMJAK4MB755WZF7W5BZFD` == `/api/health`. Fresh ledger live-settled **117W/1L** → **15m 76W/0L, 1h 41W/1L** (sole loss still `BTC 1h tLeft=600 −$29.7214`; 15m has never lost live). Gate unchanged. Backstop `node scripts/v36-forensic-audit.js` → **22 PASS / 5 WARN / 0 FAIL**.

### ⚠️ RULE-ZERO CORRECTION to §13N (two items — I got these wrong last pass and am fixing them now)
1. **`fEff` does NOT understate strand risk (§13N's last line claimed it did — RETRACTED).** `_guardedFraction` returns the guarded fraction for ask X iff `B·fGuard ≥ 5·(X+FEE(X))`; the stake `B·fGuard` is **ask-independent** and the 0.99 affordability threshold is the **highest**, so if the 0.99 calc (=`fEff`) is guarded then EVERY cheaper ask is guarded too — `fEff` being guarded mathematically GUARANTEES no cheaper-ask entry can secretly strand. If anything `fEff` slightly OVER-states risk in the narrow $10.735–$10.781 band.
2. **At the exact current $10.86 the guard is ACTIVE for every ask and a single loss is SURVIVABLE (~$5.95 left) — NOT a knife-edge strand.** Source-exact flip points this pass: ask 0.95=$10.595, 0.97=$10.688, 0.98=$10.735, 0.99=$10.781; $10.86 is **above all four**. The strand mode only applies at balances BELOW the flip (the 06-22→06-23 entries stranded because they sat at $9.76–$10.69; re-entry needs a further withdrawal or a post-loss dip). §13N's "dips into strand on any small fluctuation" overstated the instantaneous risk.

### Q1 — raise stake to ~100% / closer to 100%: DISPROVEN (dominated on BOTH growth and ruin)
- **Log-growth / Kelly** (`scripts/_pass_stake_analysis.js`): growth-optimal `f* = p − (1−p)/b`. At ask 0.98 it is **46% (p=99%) / 73% (p=99.5%) / 95% (p=99.9%)**; at 0.99 **−8% / 46% / 89%**; at 0.95 **79% / 89% / 98%**. **At f=1.0 the growth rate is `−∞`** — one loss is unrecoverable (`ln(1−1)`), so full-stake is provably ruinous for ANY loss-prob > 0. Even **f=0.95 lowers growth vs 0.85** in the realistic ask-0.98 / p≤99.5% cells. The bot's **current effective ≈0.46** (guard at $10.86) is already at/near growth-optimal for moderate assumptions — it is NOT materially under-betting.
- **Bust probability at true 100% (one loss ⇒ bust)**, `1−(1−q)^N` at OBSERVED ~5.5 fills/day: **7-day ≈ 20% → 79%, 30-day ≈ 61% → 100%** — low end at an optimistic 0.56% loss-rate, high end at the **honest CP95 upper bound q=3.87%** on the 15m 76W/0L record (0 observed losses ≠ 0 prob — Trap A5). Violates goal #3 under every honest assumption.
- **Guard coupling makes nominal-1.0 worse than it looks:** `minTradeable=(5-share cost)/f`, so a higher f SHRINKS the guard's post-loss target. At nominal f=1.0 the guard (even when active) leaves only **~$4.95 (below the $5.50 floor)** vs **~$5.83** at f=0.85 — i.e. nominal-1.0 strands on loss even where f=0.85 survives (at $10.86: f=1.0 → 6 sh, post-loss **$4.97 strand**; f=0.85 → 5 sh, post-loss **$5.95 survivable**). **VERIFIED non-monotonic sweep at $10.86 / ask 0.98:** post-loss is SURVIVABLE at nominal f=0.46–0.50 (5 sh, $5.95) and AGAIN at 0.85–0.90 (5 sh, $5.95 — the guard re-engages there), but STRANDS at f=0.60 / 0.70 / 0.80 (6/7/8 sh → $4.97 / $3.99 / $3.01) and at 1.0 ($4.97). So the current 0.85 sits in a "safe pocket" and **there is NO config-only way to nudge the stake up from here without dropping into a strand** — any measured increase requires a proper floor-aware guard REDESIGN (code + tests), not a knob.
- **Honest, non-timid verdict (Trap H3):** never 100%. The growth-optimal fraction IS higher than the current ~0.46 (≈0.5–0.7 at ask ≤0.98 IF you believe true p ≥ 99.5%), so the bot is mildly conservative — BUT per the verified sweep above you **cannot reach that band via the `SNIPE_STAKE_FRACTION` knob without dropping into the strand pocket** (0.6–0.8 all strand at $10.86). Capturing it safely needs the floor-aware guard REDESIGN (code + tests). So "more aggression" is a real, defensible option, but it is a deliberate code project (variance-for-speed), not a config tweak — and still nowhere near 100%.

### Q2 — 100% in the danger zone, less once escaped: the naive lever BACKFIRES; a clean version is low-value
- "Danger zone" = balance below the per-ask flip (~$10.6–$10.78) down to the $5.50 floor, where the guard is already inert (f=0.85) and a loss already strands.
- **Naive lever (set `SNIPE_STAKE_FRACTION=1.0`) does NOT cleanly bet 100% in the zone.** Because `minTradeable=cost/f` shrinks with f, nominal-1.0 makes the guard **activate earlier** and **non-monotonically shrink** the position in the $10.3–$10.73 band (e.g. at $10.50: f=0.85 → 9 sh / post-loss $1.67 strand, but f=1.0 → **5 sh** / post-loss $5.59 survivable — *fewer* shares), while stranding at the top ($10.86 → $4.97) and near-busting at the bottom. It also makes the escape **slower** (10 vs 7 consecutive wins to cross $9.76→$10.735) because the guard throttles the final approach. So the simple knob partly does the OPPOSITE of intent.
- **A CLEAN coded version** (apply true f=1.0 ONLY when `B < flip`, keep the guarded f above) is implementable but **low-value**: +1–2 shares and **+$0.02–$0.04 per win** in the $6–$9.7 band, escaping the ~$1-wide band ≈1 win faster, while converting a recoverable strand (post-loss ~$1–2) into a near-bust (post-loss ~$0.1). It only ever fires while IN the zone — and the bot is currently ABOVE it and climbing (each win moves up; re-entry needs a withdrawal or the first-ever 15m loss).
- **Verdict:** defensible ONLY as an explicit accept-variance sprint (consistent with the §13N leave-as-is choice), but it barely moves time-to-$100 and adds edge-case risk. Not recommended unless the operator specifically wants it; the cleaner exits remain a one-off ~$2–3 top-up (declined) or simply letting wins compound (already happening).

### Q1/Q2 FIGURES (operator-requested) — three sizing policies side by side @ ask 0.98, floor $5.50
`scripts/_pass_policy_figures.js` (A = current f=0.85+guard; B = floor-aware-aggressive = deploy max while keeping post-loss ≥ $5.50, min 5 sh; C = danger-zone-100% = true all-in when B<$10.735, guarded above). `sh / post-loss-on-a-single-loss / win-profit`:

| Balance | A current | B floor-aware | C DZ-100% sprint |
|---|---|---|---|
| **$10.86 (live now)** | 5 / **$5.95** / $0.093 | 5 / **$5.95** / $0.093 | 5 / **$5.95** / $0.093 |
| $10.50 (in band) | 9 / **$1.67 STRAND** / $0.167 | 5 / $5.59 / $0.093 | 10 / **$0.69 NEAR-BUST** / $0.186 |
| $9.764 (in band) | 8 / **$1.91 STRAND** / $0.149 | 5 / $4.86 / $0.093 | 9 / **$0.93 NEAR-BUST** / $0.167 |
| $8.00 (in band) | 6 / **$2.11 STRAND** / $0.112 | 5 / $3.09 / $0.093 | 8 / **$0.15 NEAR-BUST** / $0.149 |
| $14.00 (above band) | 8 / $6.15 / $0.149 | 8 / $6.15 / $0.149 | 8 / $6.15 / $0.149 |
| $20.00 (above band) | 14 / $6.26 / $0.260 | 14 / $6.26 / $0.260 | 14 / $6.26 / $0.260 |

**What the figures PROVE (verified, RULE ZERO):**
1. **At the live $10.86 all three policies are IDENTICAL** — 5 sh, $4.91 cost, **$5.95 post-loss (survivable)**, $0.093 win. Changing the policy does **nothing right now**; it only bites if the balance drops back below ~$10.74 (a further withdrawal or the first-ever 15m loss).
2. **Time-to-+$100 is ≈the same for all three** (all-win @ ~5.5 fills/day): **A 172 wins/~31.3d · B 164 wins/~29.8d · C 172 wins/~31.3d.** The differences exist only during the few wins spent inside the band, so NONE materially speeds the goal (C is even identical to A here, because an all-win path never re-enters the band).
3. **The only real difference is loss-exposure INSIDE the band.** Escape $9.764→$10.735: **A 7 wins (worst single-loss residue $1.68 → STRAND)**, **C 6 wins ($0.12 → NEAR-BUST)**, **B 11 wins ($4.86 → much softer)**. So **C trades a near-bust downside for ~1 fewer win (bad risk/reward); B weakly DOMINATES current (≈1.5 days faster overall AND far safer in the band)** — but every difference is tiny and confined to the ~$1-wide band.

**Figure-bottom-line:** danger-zone-100% (C) is the worst risk/reward (near-bust for ≈0 speed); floor-aware (B) is marginally better than current on both axes but negligibly so; at the current balance nothing changes. The lever that actually scales profit is still **more bankroll**, not a sizing policy.

### Q3 — FULL 5m investigation (existence, fillability, EV, flip-risk, new method) — from primary data
- **5m markets EXIST right now for ALL 6 assets** (LIVE probe 20:50–20:55Z, slug `{asset}-updown-5m-{epoch}`): active, 2-token Up/Down, every 5 min, **liquidity ~$2.2k (BNB) → ~$14.2k (BTC)**. So 5m is real & tradeable — the "killed" status is NOT due to absence.
- **Near-certainty arrives only in the last seconds.** In the probe, the 5m market closest to its close still showed the favorite at only **~0.54–0.70** (BTC Up 0.67, ETH 0.70, SOL 0.60, BNB 0.60, XRP 0.54, DOGE 0.54); the deep books were thick on the *contra* side (e.g. BTC Down 1,473 sh) — the thinness is specifically the WINNER ask in the final seconds, not the overall book. The SNIPE's ≥0.95 entry zone exists only in roughly the last ~10–30 s — a thinner window than 15m.
- **Intrinsic near-close FLIP risk (Binance-1s GROUND TRUTH, 13 days 2026-05-30→06-12, ~21,400 5m / 7,200 15m / 1,800 1h cycles, all 6 assets).** Decisive-lead (≥2σ, ≈ a ≥0.95 market) flip rate:

  | tf | T-10s | T-20s | T-30s | T-60s |
  |---|---|---|---|---|
  | **5m** | 0.37% | 0.37% | 0.53% | 1.05% |
  | **15m** | 0.21% | 0.30% | 0.37% | 0.25% |
  | **1h** | 0.06% | 0.00% | 0.00% | 0.08% |

  So a 5m SNIPE edge **is real and EV-positive in principle** (decisive flip ~0.37% < the 0.93% break-even at ask 0.99) — but it is **~1.8× riskier than 15m** at equal confidence; the all-leader (non-decisive) flip is 4–13%.
- **The real reason 5m stays killed = FILLABILITY, not "no edge."** Near-certainty only appears in the last ~10–30 s, exactly where winner asks vanish (v30/v35 76% wall) and 5m books are thinner — so realised live fills are very few (~1/day per the prior ledger; the 9 paper fills 9W/0L on 06-12 are PAPER, which assumes a fill, n=9, useless vs a 99% break-even). **A 5m SNIPE neither beats nor safely augments the 15m sleeve** — same edge, captured less often, at higher per-trade flip risk. (This sharpens the Standing-Ledger "5m EV-negative" → "5m edge real but fillability-capped & ~1.8× riskier than 15m".)
- **A NEW (non-SNIPE) 5m method is disproven on goal-alignment, not just EV:** buying the leader EARLY (e.g. T-60s) to guarantee a fill means a **12.8% all-leader flip** at an entry price ~0.54–0.70 — losing ~half-to-70% of stake ~13% of the time = exactly the high-variance, non-near-lossless profile goal #3 forbids; and since price ≈ win-probability, after Polymarket's overround the directional bet is EV-≤0 (re-confirming the buy-every-cycle / death-bounce kills, now with numbers). The shipped `strategies/strategy_set_5m_audited_v1.json` (time-of-day UP @0.22–0.45) is n=28 / 12-trade holdout, explicitly `deployGrade=false`/shadow-only — textbook overfit (Trap A1/A2/B10), not deployable.
- **5m verdict:** no near-lossless 5m strategy exists — the only near-lossless mechanic (the SNIPE) is fillability-capped on 5m, and every fillable-enough 5m method is high-variance / EV-≤0. **5m stays OFF.** (Not "mathematically impossible" — the edge exists; it is fill-limited.)

### Q4 — anything new (only after Q1–Q3 exhausted; no Kalshi cross-venue)
The flip study exposes the **single universal limiter**: the decisive-lead edge exists on EVERY timeframe (1h safest per-trade, then 15m, then 5m), but it is only capturable when the winner ask **survives** into the last seconds — which it mostly does not (~76% vanish), and earlier entries pay the overround. Every near-close variant (5m, maker-limit, earlier entry, buy-every-cycle) hits this same wall. **No new deployable edge with evidence this pass; "mathematically impossible" is NOT claimed.** Genuinely different venues (Betfair, CEX spot/futures) remain "not yet investigated" (§14) and out of scope for a near-lossless crypto-close edge — building one was not requested this pass and would be a multi-day effort, not a 24h test. The live 15m SNIPE remains the best capture of the only proven edge.

### Premortem + traps + new trap
Premortem (bust in 2 weeks?): unchanged — a single 15m loss while temporarily below the ~$10.78 flip (operator-accepted band), or two losses close together in the no-guard band. Adopting Q1 (≥0.95 stake) would turn "survivable single loss" into "7-day bust 20–79%" — the premortem's single worst lever. Section 6 swept; **new trap added — H8 "stake-fraction ↔ guard coupling"**: raising nominal f silently lowers the guard's post-loss survival target (`minTradeable=cost/f`) and can shrink/throttle positions non-monotonically — never reason about stake without re-deriving the guard at that exact f. Forward recorder: not running in this transient checkout (expected — it lives on the operator's always-on PC, never the Fly trading VM).

### Bottom line (this pass)
- **Q1 (100%):** disproven — ruinous (g→−∞; 7-day bust 20–79%, 30-day 61–100%) and below growth-optimal; current ~0.46 effective is already near-Kelly. Max safe aggression if desired ≈ fractional-Kelly 0.5–0.7 at ask ≤0.98 — operator's call, still not 100%.
- **Q2 (danger-zone 100%):** the naive config knob backfires (guard coupling); a clean coded version is low-value (~+$0.03/win, ~1 win faster escape) for a strand→bust downside, and only fires while in the zone (currently above it).
- **Q3 (5m):** markets exist for all assets; the SNIPE edge is real but fillability-capped (~1/day) and ~1.8× riskier than 15m; all fillable 5m methods are high-variance/EV-≤0 → stays OFF.
- **Q4:** no new within-Polymarket edge; the universal limiter is near-close fillability. **No live deploy yet; operator chose to BUILD the floor-aware guard (Policy B) — implemented + tested locally this pass (see below); deploy on operator OK.**

### ✅ IMPLEMENTED (operator-approved): FLOOR-AWARE GUARD (Policy B) — code + tests, NOT yet deployed
The operator picked **Build floor-aware guard (B)**. Implemented by rewriting `_guardedFraction()` in `lib/snipe-strategy.js` (the single sizing source, used by BOTH `status().fEff` (line 231) and `_openInner` sizing (line 639)). Old behaviour targeted `minTradeable=cost/f` and **fell back to full f=0.85 below the flip → deep strand**. New behaviour stakes `min(f, (B−floor)/B)`:
- leaves **EXACTLY the $5.50 floor** on a single loss for all `B ≥ ~$10.4` (never strands above the band);
- in the `~$5.5–$10.4` band caps to the **5-share CLOB minimum** (soft residue, e.g. $9.764→$4.86, NOT the old $1.91 deep strand); the emergency stop still halts new entries below $5.5;
- never exceeds nominal `f`, so high bankroll keeps a **≥15% cushion** (nominal f binds ≥ ~$36.7).
- **Translates 1:1 to the figures shown:** new `scripts/test-floor-aware-guard.js` drives the REAL method and asserts the exact approved table — **19/19 PASS**: $10.86→5 sh/$5.95; never-strand min post-loss **$5.5001** for B∈[$10.42,$60]; in-band $9.764→**$4.86**; **shares monotonic in bankroll** (fixes new Trap H8); guarded ≤ f; `fEff`=0.4936.
- **Verification:** `node --check lib/snipe-strategy.js` OK · `node scripts/test-floor-aware-guard.js` 19/19 PASS · `node scripts/v36-forensic-audit.js` **22 PASS / 5 WARN / 0 FAIL** (its strand-survivability text was updated to Policy B so the backstop is not stale — Trap H7). Header docstring + guard comment de-staled.
- **Net effect:** removes the post-withdrawal deep-strand entirely; marginally faster to +$100 (~30 vs ~31 days, all-win). **Supersedes §13N's operator "leave-as-is" choice** (now an explicit upgrade to safer sizing).
- **⚠️ NOT DEPLOYED.** The live bot still runs the OLD guard until a Fly deploy. Deploy step (operator OK required): `fly deploy` (from repo root), then re-pull `/api/health` + `/api/status` and assert the new image == running machine and `fEff≈0.49` at ~$10.86. Until then nothing about live trading has changed. **[SUPERSEDED 2026-06-25 — Policy B IS NOW LIVE: it shipped with the account-migration deploy; the live runtime `fEff` now reconciles EXACTLY to `(B−floor)/B`, proving the new guard is running. See §13P.]**

---

## 13P. FIRST POST-CUTOVER AUDIT — POLICY B CONFIRMED LIVE ON THE NEW ACCOUNT + RECORDER RESTARTED (2026-06-25, ~15:46 local)

This pass re-ran the MASTER AUDIT & INVESTIGATION PROTOCOL from the Section 8 cold-start trigger — the FIRST pass after the live bot was migrated to the operator's billed Fly account. Manual char-by-char read of the live trading path (`lib/snipe-strategy.js` gates docstring vs code, the `_guardedFraction()` body L447-460, `status()`/sizing); live parity from the NEW app `https://polyprophet-live.fly.dev` (`/api/health`, `/api/status`); fresh recompute from the freshest local ledger (the **2026-06-25 07:00 backup**, 3549 records — freshest available, since the OLD Fly box is stopped so its `/data` is frozen and `scripts/live-ledger.jsonl` froze ~06-20); backstop `scripts/v36-forensic-audit.js`. **No trading logic/config changed; nothing deployed this pass** (the Policy-B deploy + account cutover already happened in the prior tasks).

### ⚠️ Runtime moved: the live bot is now `polyprophet-live` (billed account), NOT `polyprophet`
Every prior §13x entry — and the audit script's old default — pointed at `polyprophet.fly.dev`. That OLD app/machine (`1857502a542408`, image `…BZFD`) is **STOPPED + CORDONED** (the old account also has overdue billing); the SOLE live bot is now **`polyprophet-live`** (region `gru`, machine `7847926f3de498`) on `lingerslongers@gmail.com`. Both apps share the same on-chain wallet (`POLYMARKET_PRIVATE_KEY` → funder `0x49756…6e97`), so only one may ever be live — the old is decommissioned (volume preserved). **Fixed this pass:** `scripts/v36-forensic-audit.js` `API_BASE` default `polyprophet.fly.dev` → `polyprophet-live.fly.dev` (the stale URL was the prior Section-B FAIL).

### Live state re-pulled (primary — NEW app `/api/health` + `/api/status`)
`health=ok, isLive=true, snipe.mode=LIVE, enabled=true, paperMode=false, muted=false`. Bankroll **$12.985904** (`sizingSource=live-refreshed-wallet`). `K(maxConcurrent)=2, f=0.85, fEff=0.5765, minBankrollFloor=5.5`, `allowedTimeframes=[15m,1h]`, `settled=228, wins=227, losses=1, open=0`, `lastError=NO_FILL_AFTER_RETRIES` (benign FOK no-fill, correctly SKIPPED as `NON_BALANCE_ALLOWANCE_TRIGGER`). **Re-pull `/api/status` for the live balance every pass — never trust a number written in this file.**

### ✅ RULE-ZERO UPDATE — Policy B (floor-aware guard) IS NOW LIVE (supersedes §13O "NOT DEPLOYED")
§13O ended "⚠️ NOT DEPLOYED — the live bot still runs the OLD guard." That is now FALSE and is corrected here: the migration deploy shipped Policy B. **Proof from primary runtime:** live `fEff=0.5765` at `B=$12.9859, floor=5.5` reconciles EXACTLY to the Policy-B formula `min(f,(B−floor)/B) = (12.9859−5.5)/12.9859 = 0.5765` (the OLD guard targeted `minTradeable=cost/f` and would show a different fraction / fall back to f=0.85 below the flip). Manual read of `_guardedFraction()` (L447-460) confirms the body is `guarded=min(f,(B−floor)/B)` with the 5-share-min soft floor — identical to the §13O-approved, 19/19-tested code. **At the current $12.99 a single loss leaves ~$6.05 (> $5.50 floor) — survivable, NOT a strand.**

### Code == live runtime (verified char-by-char + audit parse + docstring)
Gate constants parsed from `lib/snipe-strategy.js` == manual read == audit parse == header docstring (no H7 stale-comment drift this pass): `deepMax 15m=300 / 1h=120 / 5m=120; deepMin1h=60; minBps deep 15m=25 / 1h=20 / 5m=30, final 15m=10 / other=20; z≥3; askCap deep1h=0.99 / deepOther=0.97 / final=0.99; depth≥5; FEE=0.072·p·(1−p); floor=$5.5; f=0.85; FOK`. Audit Section B (code vs live runtime) now PASSES against the new app (`tradeFailureHalt.halted=false`).

### Ledger recompute (primary — freshest local ledger, 2026-06-25 07:00 backup, 3549 records)
Live-settled, deduped by `asset:tf:epoch` = **125W / 1L** (the 2468 `LIVE_RECONCILE_PENDING` poll-duplicates confirm dedup is mandatory). It reconciles: 99 paper `SETTLE` + 126 live outcomes = **225 settled** == the 07:00 snapshot `settled=225`; the live API has since grown to **227W/1L** as ~3 more 15m wins settled post-cutover. By timeframe: **15m 86W/0L, 1h 39W/1L** — **15m has STILL never lost live.** Sole loss unchanged: **BTC 1h, side=down, ask 0.99, 30 sh, sig.tLeft=600, bps=38.64, z=3.11, pnl=−$29.7214** — `tLeft=600 > deepMax1h=120`, so the deployed 1h gate **still removes this exact entry** (verified True).

### Honest PnL / fills / timeline (OBSERVED vs PROJECTED — RULE ZERO)
- **All-time realized LIVE PnL = −$15.16** (125 wins sum **+$14.56** at avg **+$0.1165/win**, vs the single **−$29.72** loss). The win RATE is near-lossless (**125/126 = 99.2%**), but realized trading PnL is **net-negative all-time** because one asymmetric loss still outweighs 125 small wins (Trap A6, live-confirmed). The positive bankroll comes from committed-capital/deposit history, NOT cumulative trading profit. **Post-loss (15m-only) realized PnL is positive and growing** (zero losses since 06-19; consistent with §13N's +$2.69-and-climbing).
- **OBSERVED fills/day (freshest ledger):** PRE-tightening (06-14…06-19) = **16.0/day** (96/6); POST-tightening (06-20…06-24) = **6.0/day** (30/5). The gate cut the rate **~62%** (>20% → flagged, Method D). The 1h `deepMax=120` gate has produced **zero 1h fills since 06-19** — post-tightening fills are **15m-only**. So the **deployed-gate OBSERVED rate ≈ 6/day**, corroborating §13N/§13O; the audit's PROJECTED 8/day (62.7% survival × stale-ledger history) is an upper estimate, not yet observed.
- **Time to +$100 (honest, assumes the no-further-loss win-path):** at ~6 fills/day + ~0.93%/fill edge with compounding (guarded f rising 0.58→0.85, then 0.85 flat ≥$36.7), **≈ 6–8 weeks** from ~$13 — faster (~3 weeks) only if fills recover toward the historical ~16/day. **$100 in 7 days remains IMPOSSIBLE** (needs ~45–60 fills/day). ⚠️ The Section-8 cold-start "~17-24 fills/day, ~2-4 weeks" reflects the raw/pre-tightening supply and its optimistic end; the honest **deployed** figure is ~6/day → multi-week-to-~2-months.
- **Loss-prob:** point estimate 1/126 = **0.79%**; **95% Clopper-Pearson upper bound ≈ 2.4–4.3%** (NOT 0 — Trap A5). At ask 0.99 the break-even win rate is ~99% (each win ≈ +1%, each loss −100%), so the edge is a genuine knife-edge; the gate tightening (1h ≤120s, 15m bps≥25, ask caps) is what keeps it on the right side — not a wide margin.

### Liquidity / combined-vs-individual (re-confirmed; no new tape mining this pass)
At ~$13 the 5–7-share order is far below book depth (the live signal showed `bestAskSize≈57`; historical cap-depths 150–2,458), so depth is NOT the binding constraint now — fills/day + loss-risk are. Per §13C/§13L size becomes liquidity-capped only ≈ **B$177** (linear past there; fully liquidity-linear ~$3,425 — upper bounds; deep BTC books vanish ~76% near close). Only SNIPE clears the 99.07% break-even, so **combined-portfolio profit == individual SNIPE profit** today.

### Forward recorder — was DOWN; RESTARTED + verified this pass (durable autostart deferred to operator)
**Finding (proof, not assumption):** the default output dir `data/forward-second-clob` had **never been created** on this box, no collector process was running, and no `POLYPROPHET-ForwardCollector` Scheduled Task exists (the `-tape`/`-condensed` dirs are old, frozen 06-01 / 06-19). No fresh forward tape has been collected for days — which is exactly why Mandate-3 strategy search has had no new data to mine. **Action taken:** started `scripts/forward-second-clob-collector.js` and **VERIFIED** it discovered 26 active markets and is writing `data/forward-second-clob/2026-06-25/` at **26 snapshots/second** (functional proof — stronger than the audit's Section-F "files present" check). **Honest limitation:** the autostart installer was BLOCKED in this environment (`Register-ScheduledTask: Access is denied`), and the collector I started is a transient session process that **stops when this session ends**. **OPERATOR ACTION for durable always-on:** on the always-on PC run `powershell -ExecutionPolicy Bypass -File scripts\install-collector-autostart.ps1` (registers the at-logon task + starts it). Until then no fresh tape persists.

### Strategy search (Mandate 3) + premortem + trap sweep
No new deployable edge this pass (the recorder being down meant no fresh tape; it is now restarted for the next pass). Re-confirmed the Standing Strategy Ledger from existing evidence (cross-asset momentum, Hyperliquid perps, buy-every-cycle, wider-z gates, maker-limit, streak-reversal, 5m) — all remain killed / EV≤0 / fillability-capped; "mathematically impossible" is NOT claimed. **Premortem (bust in 2 weeks?):** the realistic path is a *new* 15m-deep reversal (15m has never lost live; bounded by z≥3 / bps≥25 / ask≤0.97) or two losses close together while temporarily below the ~$10.4 guard band — but Policy B now leaves ≥$5.50 on ANY single loss for B≥~$10.4, so the single-loss strand is removed at the current balance. Walked Section 6 + the audit's 10-item checklist — none newly triggered; no new trap.

### Backstop + verification
`node scripts/v36-forensic-audit.js` (now pointed at the live app) → exit 0, **22 PASS / 5 WARN / 0 FAIL** (the prior 1 FAIL was the stale old-app URL, fixed; the 5 WARNs are the standing honest-judgement items: PROJECTED ≠ OBSERVED fills/day, benign `NO_FILL`, gate cuts historical rate >20%, loss-rate CI, $100/7d impossible). Gate constants parsed from source unchanged; recorder confirmed writing today's data.

---

## 13Q. MAX-SPEED / MAX-EFFICIENCY AUDIT — NO SAFE CONFIG SHORTCUT; BANKROLL IS THE ONLY CLEAN SPEED LEVER (2026-06-25, ~17:10 local)

This pass continued the MASTER AUDIT & INVESTIGATION PROTOCOL for the operator's direct question: **"Can we reach our desired goal quicker or in a more efficient manner? By any means? Without exponentially increasing bust / strand / variance risk?"** Manual live-path read covered `lib/snipe-strategy.js`, `lib/trade-executor.js`, `lib/clob-client.js`, `lib/risk-manager.js`, `server.js`, and `lib/config.js`; live parity was re-pulled from the current app `https://polyprophet-live.fly.dev`; the backup live ledger and live deployment ledger metadata were checked; the local forward recorder and autostart state were checked; and Betfair API feasibility was spot-checked from current public developer/support pages. **No trading logic/config changed; nothing deployed this pass.**

### Live state re-pulled (primary API, 2026-06-25T17:03:37+01:00)
`health/status ok`, `mode=LIVE`, `snipe.mode=LIVE`, `enabled=true`, `muted=false`, no open positions, no pending reconciliation, no trade-failure/error halt, drawdown brake inactive. Current live/sizing/accounting bankroll = **$13.284084 USDC** (`sizingSource=live-refreshed-wallet`), `f=0.85`, Policy-B `fEff=0.5860`, `minBankrollFloor=$5.50`, `K=2`, `allowedTimeframes=[15m,1h]`, aggregate state counter **229W / 1L / 230 settled**, last error `NO_FILL_AFTER_RETRIES` (benign FOK no-fill). A prior pull during this pass briefly showed lower balance values; a later fresh `/api/status` pull corrected the authoritative current figure to `$13.284084`, so the lower transient values are **not used** in projections.

### Ledger / fill-rate evidence (OBSERVED vs PROJECTED; source-labelled)
- **Backup ledger parsed this pass:** `POLYPROPHET_FULL_BACKUP_20260625/data-state/snipe/ledger.jsonl`, 3549 records. Correct method is **not** plain `SETTLE live=true`; later live outcomes are `LIVE_OUTCOME_PENDING_RECONCILIATION` / `LIVE_RECONCILED`, deduped by `asset:tf:epoch:side` and joined to `ENTRY` rows for ask/signal fields. Parsed result through 2026-06-24T23:30:45Z: **127W / 1L live outcomes**, all-time live realized PnL **−$14.7504**, sole loss unchanged: `BTC 1h`, ask `0.99`, `30` shares, `tLeft=600`, `bps=38.64`, `z=3.11`, `pnl=−$29.7214`.
- **Current deployment ledger metadata:** `fly ssh console -a polyprophet-live --command "wc -l /data/snipe/ledger.jsonl"` printed **3564 lines**, so the live ledger is only 15 lines ahead of the backup artifact. Raw `tail` showed recent `LIVE_ORDER_REJECTED` / `NO_FILL_AFTER_RETRIES` rows after the backup. A compact remote parser was attempted but blocked by Windows/Fly quoting; therefore this pass labels live-only parsed stats from the backup and uses `/api/status` for the newest aggregate state.
- **Recent observed deployed performance:** backup 2026-06-24 slice = **9W / 0L**, `+$1.107`, **9.39 fills/day**, all `15m`. The audit backstop, using the stale `scripts/live-ledger.jsonl`, reports historical live full-day **12.75 fills/day** and **PROJECTED 8.0/day** under the current gate. These are not interchangeable: the honest current range is **OBSERVED ~6-9/day** depending window, with **8/day** still best treated as a projection/upper planning case until a full fresh 24h tape/ledger window is parsed.

### Honest speed math from the current bankroll (no further-loss path, not a promise)
Using current `B=$13.284084`, per-fill edge `~0.93% of cost`, Policy-B guard until nominal `f=0.85` binds, and target `B + $100 = $113.2841`:

| Fill assumption | Source label | Approx days to +$100 |
|---|---|---:|
| 6/day | Recent deployed observed lower case from §13P/§13N | **50 days** |
| 8/day | Audit projected current-gate case | **38 days** |
| 9.39/day | 2026-06-24 backup-slice observed | **33 days** |
| 10/day | Optimistic round-number current-gate case | **31 days** |
| 12.75/day | Historical full-day audit average, not current observed | **25 days** |
| 16/day | Pre-tightening supply, not deployed-gate reality | **20 days** |

**Rule-Zero answer:** from the current ~$13 bankroll, **+$100 in 7 days is still not reachable by config/search magic without a huge fill-rate increase**. It needs roughly the same impossible `~45-60 fills/day` order of magnitude already documented; the current live market/gate is producing single-digit to low-double-digit fills/day.

### Loss / strand / liquidity math now
- **Single-loss survival now:** Policy B is live and current bankroll is above the guard band. Source-exact share rounding at `B=$13.284084` leaves about **$5.51-$6.41** after a one-trade loss depending ask (`0.96` → 8 shares / post-loss `$5.582`; `0.97` → `$5.507`; `0.98` → `$6.414`; `0.99` → `$6.349`). So a single current loss is **survivable**, not a strand, but it would reset the bot near the floor.
- **Loss probability is not zero:** the only observed live loss is now gated out (`1h tLeft=600 > deepMax1h=120`), and 15m still has no live loss in the parsed ledger, but `0` current-gate losses does **not** prove `0%` risk. A conservative zero-loss upper bound on 74 historical fills surviving the current gate is about **4%**; practical risk planning should continue using the standing small-loss-rate range, not a zero-loss assumption.
- **Liquidity is not the near-term bottleneck:** at `$13`, the bot asks for roughly 7-8 shares depending price; this is far below the historical median cap-depth (~152 shares). The old liquidity cap remains the same: sizing begins to become depth-limited around **B≈$177** and fully liquidity-linear near **B≈$3,425**. Current bottleneck is **fills/day + residual loss risk**, not depth.
- **Combined portfolio:** still **SNIPE-only**. No concurrent strategy currently clears live-transfer/break-even, so combined-portfolio profit equals individual SNIPE profit today.

### The actual fastest path, ranked honestly
1. **Best deployable now: keep current Policy-B SNIPE unchanged.** It is already the speed/safety compromise: 15m tightened, 1h restricted to `60-120s`, `z>=3`, ask caps, `K=2`, live-refreshed sizing, FOK no-fill discipline. Loosening any of these adds fills by reopening known loss/fillability traps.
2. **Fastest clean accelerator: add bankroll, not risk.** This does not create profit, but it converts the same edge into more dollars/fill without changing the per-trade signal. Approx `+$100` time at observed `6/day`: start `$20` → **40d**, `$36.7` → **29d**, `$50` → **24d**, `$100` → **15d**, `$177` → **10d** (before liquidity becomes the next major constraint). This is the only lever found that materially speeds the target **without** exponentially increasing loss/strand/variance risk; absolute dollars-at-risk rise, but Policy B preserves the floor for a single current-gate loss while bankroll is above the guard threshold.
3. **Evidence-gated, not deployable now: maker/FAK/earlier-entry shadow.** The local recorder is now writing data again, so the next useful experiment is a ≤24h shadow that measures whether FAK/maker/earlier-entry variants create real fills beyond the current FOK lane without lowering realized win probability. Do not deploy live until it clears break-even after queue/fill reality.
4. **Rejected now: reopen 1h `tLeft>120`, loosen 15m bps, lower z, enable 5m, or force buy-every-cycle.** Each is exactly the kind of speed that buys fills by adding the variance/loss mechanism the operator asked to avoid. 5m has a real theoretical edge but is fillability-capped and ~1.8x riskier than 15m; buy-every-cycle/earlier leader buys are overround/high-variance; maker remains queue-uncertain.
5. **Different venue check:** Betfair is real and UK-accessible with automation support, but current public Betfair support says **Live App Key access for betting purposes has a one-off £499 activation fee**. That makes it economically irrelevant for the current ~$13 sprint unless externally funded. CEX/perps/DeFi remain future research categories, but no primary-data edge was found this pass that beats the current SNIPE live-transfer bar.

### Forward recorder / backup / verification
- **Recorder:** expected collector scripts exist and `data\forward-second-clob` is writing today: `82` files, `180,136,121` bytes, latest write `2026-06-25T16:33:55+01:00`. However there is **no** `POLYPROPHET-ForwardCollector` Scheduled Task and no `2026-06-24` gzip/plain files in that directory, so durable autostart and yesterday compression are **not confirmed**. Operator action remains: install/start the scheduled collector on the always-on PC and verify day rollover compression.
- **Backup:** `POLYPROPHET_FULL_BACKUP_20260625` exists with manifest entries for app/config/secrets/state; no config/secrets were changed this pass, so no backup refresh was required.
- **Backstop:** `node scripts/v36-forensic-audit.js` exited `0`, **22 PASS / 5 WARN / 0 FAIL**. WARNs are honest judgement items: benign `NO_FILL_AFTER_RETRIES`, PROJECTED-vs-OBSERVED fill-rate warning, gate cuts historical rate >20%, nonzero loss-rate CI, and `$100/7d` impossibility. Note: its ledger section used stale `scripts/live-ledger.jsonl` (3398 records), so this README section supersedes it with the fresher backup/live-status checks where they differ.

### Premortem + trap sweep + final answer to the operator
Premortem: if the bankroll is damaged in the next two weeks, the likeliest cause is **a new 15m reversal that has not occurred live yet**, or a cluster of losses after the first loss resets the bot near the `$5.50` floor. The known `1h tLeft=600` loss mechanism remains blocked; no Section 6 / Section 14 / hub §5A trap was intentionally accepted. The one process trap observed this pass is **ledger-method drift**: `SETTLE live=true` undercounts live outcomes because later outcomes use reconciliation event types; future passes must parse `LIVE_OUTCOME_PENDING_RECONCILIATION` / `LIVE_RECONCILED` too.

**Bottom line:** yes, we can reach the goal **more efficiently** by keeping the current SNIPE exactly as deployed and optionally increasing bankroll; no verified config/new-venue shortcut was found that reaches `$100+` materially faster **without** paying for it with sharply higher bust/strand/variance/loss risk. The honest current no-loss timeline is **~33-50 days** from `$13` under the deployed observed/projected fill range; a top-up to `$50-$100` cuts that to **~15-24 days at 6/day** without changing the strategy's per-trade risk profile, but it puts more absolute capital at risk.

---

## 13R. OPERATOR Q&A PASS — SUB-0.99 FILLS, EARLIER ENTRY, FILLS/DAY VARIANCE, ACCOUNT-LOCK SELF-CUSTODY + WITHDRAW, NEW DEPOSIT (2026-06-25, ~19:36 local)

This pass re-ran the MASTER AUDIT & INVESTIGATION PROTOCOL to answer the operator's direct questions: (Q1) why some fills are 0.97/0.98 not 0.99 and is that safe; (Q2) should we buy earlier; (Q3) do fills/day vary and can they be predicted; (Q4) can we avoid being locked out of our funds (self-custody + quick-switch + backup + control "from here"); (Q5) how fills change the timeline; (Q6) a new ~£15 deposit + possible emergency withdrawals. Manual char-by-char read of the live SNIPE gate block (`lib/snipe-strategy.js` L998-1050) + the custody/withdraw path (`lib/clob-client.js` L304-326, L594-810, L3370-3417; `lib/telegram-commands.js` L945-1050); live parity re-pulled from `https://polyprophet-live.fly.dev`; fresh dedup recompute from the backup ledger (3549 records) via new `scripts/v36r-fill-ask-distribution.js`; on-chain verification of the Base deposit tx; recorder + backup + backstop checks. **No trading logic/config changed; nothing deployed this pass.**

### Live state re-pulled (primary)
`mode=LIVE, snipe.mode=LIVE, enabled=true, paperMode=false, muted=false`, not halted, `sigType=3`. Bankroll **$14.105** at 18:23Z then **$14.403** at 18:36Z (`sizingSource=live-refreshed-wallet`) — it moves with each win/settle and the pending deposit, so **always re-pull `/api/status`; never quote a number from this file as current**. `f=0.85`, Policy-B `fEff≈0.61`, `floor=$5.5`, `K=2`, `[15m,1h]`, aggregate `~232W/1L`, `lastError=NO_FILL_AFTER_RETRIES` (benign). Old `polyprophet`/Render hosts return 503 (decommissioned); `polyprophet-live` is the SOLE live bot.

### Q1 — Cheaper-than-0.99 fills: VERIFIED, intended, and strictly GOOD (keep exactly as-is)
Live code (L1033) `askCap = inDeep ? (tf==='1h'?0.99:0.97) : 0.99`; entry price (L1042) `= useCapSweep ? askCap : book.bestAsk`. The bot pays the **current best ask**, only "sweeping" toward the cap on orders too big for the top level — and cap-sweep does NOT trigger at this bankroll (order ≈7-8 sh vs book depth 50-2,400+). The deep-15m cap is **0.97** (deliberately TIGHTER/safer than 0.99); final-window + 1h-deep cap is 0.99.
- **OBSERVED ask distribution (128 deduped live fills, recomputed this pass):** `0.99`=97 (75.8%), `0.98`=12 (9.4%), `0.97`=7 (5.5%), `0.96`=8 (6.3%), `0.95`=2, `0.93`=1, `0.90`=1 → **24.2% of fills are cheaper than 0.99** (almost all on 15m; the sub-0.95 handful are 15m final-window bargains where the best ask briefly dipped while z/bps still passed). Your observation is exact.
- **Does it add loss risk? NO — it is pure upside.** Dollars at risk per trade ≈ `cost = f·B` REGARDLESS of ask (you buy `f·B/ask` shares, so a cheaper ask buys MORE shares for the SAME ~`f·B` cost). A loss costs the same either way; a win pays `f·B·(1−ask)/ask` ≈ **3.1% at 0.97 vs 1.0% at 0.99** — roughly **3× the profit for identical downside**. Win-certainty is governed by the z≥3 / bps≥25(15m-deep) / depth≥5 gates, NOT by the ask. **Verdict: the cheaper fills are a genuine free bonus — leave it as-is ("happy days").**

### Q2 — Buy earlier? NO (earlier entry is literally what caused the only live loss)
Earlier entry = more `tLeft` = more time for a reversal. The single live loss was **BTC 1h at tLeft=600s (~10 min out)**; the gate was tightened to 1h `(60,120]` precisely to remove it (`deepMax1h=120`, verified L1005). 15m already enters as early as 300s (deep) and we still harvest the cheap fills above from the *late, move-confirmed* window. Buying earlier to chase more cheap fills re-imports the reversal risk we eliminated, and last-seconds entries on hourly books are unfillable (winner asks vanish — B5/B8). **Keep current windows.** The only acceptable way to test earlier/maker entry is a ≤24h SHADOW (recorder now has data) that must clear break-even after queue/fill reality before any live change.

### Q3 — Do fills/day vary? Can they be predicted? YES they vary; NO, not an exact number — only a range
Recomputed per-UTC-day live fills:
- PRE-tightening (06-14…06-19, 15m+1h): **12, 17, 9, 18, 19, 23** → 9-23/day.
- POST-tightening (06-20…06-24, 15m-only deployed gate): **3, 7, 6, 5, 9** → **mean 6.0, median 6, min 3, max 9**.
A fill happens only when a cycle throws a qualifying near-certainty signal (z≥3, bps≥gate, ask≤cap, depth≥5) AND it fills FOK. That supply depends on the day's volatility/directional clarity across the 6 assets, so it is a **distribution, not a constant**. Your "~10 today" is a good day at the top of the current band. **Plan on ~6/day (≈3-10 range) under the deployed gate; treat higher as upside, not a promise.** ~20/day only existed in the looser pre-tightening regime, which carried the 1h loss mechanism.

### Q4 — Locked-out protection: you ALREADY have on-chain self-custody (full picture)
- **You hold the master key.** The bot signs with `new ethers.Wallet(POLYMARKET_PRIVATE_KEY)` (clob-client.js L608) — a self-held EOA. For `sigType=3` (POLY_1271 "deposit-wallet": L311-326) that EOA signs all typed data while the **funder/proxy `0x49756…6e97`** (a Polymarket proxy on Polygon, derived from / pinned to your EOA via `POLYMARKET_ADDRESS`) holds the funds as on-chain pUSD. **Whoever holds the EOA key controls the proxy and its money — independent of Polymarket's website.** A UI lock or verification prompt cannot freeze on-chain funds you can already sign for.
- **The bot can push an EMERGENCY WITHDRAWAL "from here."** `clob-client.js:withdrawPusdFromProxy(to, amount)` (L3370) signs an on-chain pUSD `transfer` out of the proxy, exposed via Telegram `/withdraw AMOUNT` → `/confirm_withdraw TOKEN` (telegram-commands.js L945/L1002). It is currently **OFF by default** — enabling it needs `TELEGRAM_WALLET_CONTROLS_ENABLED=true`, `TELEGRAM_WITHDRAW_ENABLED=true`, a fixed `TELEGRAM_WITHDRAW_TO_ADDRESS` (your own Polygon address), and `TELEGRAM_WITHDRAW_MAX_USDC`. Turning these on = one-tap cash-out to YOUR address even if the Polymarket site is down. **Honest nuance:** the built-in path uses Polymarket's gasless proxy relayer; if that relayer were ever unavailable, the ultimate backstop is the key itself — sign the proxy transfer via any Polygon RPC. Either way the money is reachable because you hold the key.
- **Quick-switch is already proven + trivial.** Funds live with the KEY, not the host. You migrated old `polyprophet` → `polyprophet-live` today with zero fund movement (same key ⇒ same proxy ⇒ same money). To switch again: deploy the same image and set the same `POLYMARKET_PRIVATE_KEY`/`POLYMARKET_ADDRESS` secrets on a new Fly app — the backup's `redeploy-new-account.ps1` automates it.
- **Backup is complete + current.** `POLYPROPHET_FULL_BACKUP_20260625/` contains `SECRETS/.env.secrets` (private key + all secrets), `live-secret-names.txt` (confirms `POLYMARKET_PRIVATE_KEY`/`POLYMARKET_SIGNATURE_TYPE`/`POLYMARKET_ADDRESS` captured), `config/`, `data-state/` (ledger + state), `RESTORE.md`, `redeploy-new-account.ps1`. **Operator action (once): copy this folder to a USB/offline drive, and store the single line that matters most — `POLYMARKET_PRIVATE_KEY` — somewhere only you control (e.g. imported into a personal wallet). That one key = full control of the money forever, with no dependency on this repo, Fly, or Polymarket's UI.**

### Q5 — How fills/day changes the timeline (honest, no-further-loss path, not a promise)
Per-fill edge ~0.93% of cost, compounding under Policy-B `f`. From ~$14: **6/day ≈ 50d**, 8/day ≈ 38d, 9.4/day ≈ 33d, 10/day ≈ 31d, 12.8/day ≈ 25d to +$100. **Plan on ~6/day ⇒ multi-week (~6-8 weeks)**; faster only if fills run hot. **$100 in 7 days is impossible** (needs ~45-60 fills/day vs the ~3-10 the gate supplies). The one clean accelerator that does NOT raise per-trade risk is **more bankroll** (Q6).

### Q6 — New deposit + emergency withdrawals
- **Deposit verified on-chain:** Base tx `0xb2d8…97b8` is a **USDC transfer of 19.865839 USDC (≈ £15)**, status **success (0x1)**, sent to Base address `0xb3813ec1…1024` (a cross-chain deposit address). It must still **bridge to Polygon** and credit your proxy — that is why live bankroll (~$14.4) doesn't include it yet ("waiting to enter" is correct). **Confirm it credits in the Polymarket UI / via `/api/status`; if it hasn't landed within the usual bridge time, flag it.** Once it lands, bankroll ≈ **$34** ⇒ roughly halves time-to-target (≈ $36.7 → ~29-31d at 6/day; faster at higher fills).
- **Emergency withdrawals are fine and safe.** Pull funds anytime via the Polymarket UI, the bot `/withdraw` (Q4), or the key directly. Withdrawing lowers bankroll and slows compounding (fewer dollars/fill) but **cannot bust you** — Policy B keeps ≥ $5.50 after any single loss for `B ≥ ~$10.4`, and the bot just trades smaller / pauses below the $5.5 floor. **Tip: keep ≳ $11 working in the bot** to preserve the "single loss never strands" guarantee; dip below only for genuine emergencies.

### Recorder / backup / backstop / traps
- **Forward recorder is DOWN** (last wrote 16:33 local; the prior pass's transient process ended). Durable always-on still needs the operator to run `powershell -ExecutionPolicy Bypass -File scripts\install-collector-autostart.ps1` on the always-on PC (auto-install is blocked in the agent env). Reported, not hidden.
- **Backup:** current; no secrets/config changed this pass.
- **Backstop `node scripts/v36-forensic-audit.js`:** exit 0, **22 PASS / 5 WARN / 0 FAIL**; code==runtime asserted (`sigType=3`, tradeReady ok, not halted); constants parsed from source unchanged (FEE 0.072, floor 5.5, f 0.85, FOK). WARNs = standing honest-judgement items (PROJECTED≠OBSERVED fills/day, benign NO_FILL, gate keeps ~63% of historical rate, loss-rate 95% CI ≈2.44% NOT zero, $100/7d impossible).
- **Premortem/traps:** no new trap. Likeliest 2-week damage path remains a *first-ever* 15m reversal or a loss cluster near the floor — bounded by z≥3/bps≥25/ask≤0.97 and Policy B. Freshness note: this pass's dedup parse counts 1h **41W/1L** (vs §13P's 39W/1L) — same single loss, 15m still **0L**; the +2 are later-reconciled 1h wins, not a contradiction.

**Bottom line for the operator:** (1) the cheaper fills are a real free bonus — leave them; (2) don't buy earlier — that's the one thing that ever lost; (3) fills/day swing ~3-10 under the current gate (~6 typical), so plan on ~6, not a fixed number; (4) you already control your money via your own key — back that key up off-site, and optionally switch on Telegram `/withdraw` to a fixed address you own for instant emergency cash-out; (5) the ~$19.87 deposit speeds things up once it bridges; (6) withdraw whenever you need — it slows growth but cannot bust you while you keep ≳$11 in.

---

## 13S. OPERATOR Q&A PASS — "BUY CHEAPER" CLARIFIED, IS 15m REALLY LOSSLESS, ARE WE TOO TIGHT / CAN WE INCREASE FILLS, DEPOSIT LANDED (2026-06-25, ~21:00 local)

Follow-up to §13R. The operator clarified that "buy earlier" meant **buy at a cheaper price**, asked whether the 1h-loss mechanism even applies to 15m (prove/disprove, paper allowed), whether we can raise fills back toward pre-tightening levels by **slightly loosening while keeping low bust/strand/variance/loss risk**, and confirmed the deposit has arrived. This pass did the full protocol: live re-pull, char-by-char gate read, fresh ledger recompute, AND an **independent 23-day per-second backtest** that re-derives the gate calibration from primary data (NOT the in-code comment). **No trading logic/config changed; nothing deployed.** Two new analysis scripts added: `scripts/v36s-gate-tightness-analysis.js`, `scripts/v36s-15m-vs-1h-reversal-backtest.js`.

### Live state re-pulled (primary) — DEPOSIT LANDED
`mode=LIVE, snipe.enabled=true, paperMode=false`, not paused/halted, `sigType=3`. **Bankroll = $34.269133** (`balanceBreakdown.onChainPusd=34.269133`, `clobCollateralUsdc=34.269133`, `sizingSource=live-refreshed-wallet`) — the ~£15 (19.865839 USDC) deposit from §13R has **bridged Base→Polygon and credited the proxy**; live bankroll ≈ **doubled** ($14.4 → $34.27). `snipe.fEff=0.8395` (Policy-B guard now near full f=0.85 because $34 is well clear of the floor), `floor=$5.5`, `K=2`, `[15m,1h]`. `snipe.settled=234, wins=233, losses=1`. (`accountingBankroll` still shows 14.40 — a lagging accounting mirror; the **live wallet $34.27 is the sizing source**.) Always re-pull `/api/status`.

### Reconciliation of the 234-vs-128 count (RULE ZERO — resolved cleanly, no contradiction)
Dedup of the freshest local ledger (backup `data-state/snipe/ledger.jsonl`, through ~06-25 05:45Z): **225 settled = 97 PAPER (97W/0L) + 128 LIVE (127W/1L)**. `snipe.settled=234` counts **paper-phase + live** settles; live-only now ≈ **137 (136W/1L)** — the +9 vs the backup are today's later live wins. By timeframe: **15m = 86W/0L** (15 deep + 71 final), **1h = 41W/1L**. The single live loss is still the one BTC 1h; **15m has 0 live losses**.

### Q-A — "Buy cheaper" is NOT a free lever; we already harvest it (leave as-is)
The bot pays the **current best ask** (snipe-strategy.js L1042), capped at **0.97 in the 15m-deep window** and 0.99 in 15m-final / 1h-deep (L1033). You cannot "decide" to pay less — the market sets the ask. The only ways to systematically get cheaper fills are (i) **enter earlier** (the deep window already does this, hence the 0.97 cap and the 24.2% of fills below 0.99) or (ii) **post maker bids** (queue risk, unproven — v33/v34). Lowering the cap further would **reject** asks above it (fewer fills), not make the same trade cheaper. **Recomputed live ask distribution (128 live fills):** 0.99=97, 0.98=12, 0.97=7, 0.96=8, 0.95=2, 0.93=1, 0.90=1 → cheaper-than-0.99 = 31/128 = **24.2%**, almost all 15m. As established in §13R, a cheaper ask buys MORE shares for the same `f·B` cost ⇒ **same downside, ~3× the win profit at 0.97 vs 0.99**. Verdict: the cheaper fills are a genuine bonus already being captured; **no change** ("happy days" is correct).

### Q-B — Does the 1h reversal mechanism apply to 15m? PARTIALLY — 15m is NOT truly lossless (RULE ZERO correction)
Independent backtest (`v36s-15m-vs-1h-reversal-backtest.js`, 2026-05-20…06-12, 6 assets, per-second Binance + chainlink truth; **7,205 15m + 1,830 1h** cycles scanned), replaying the bot's exact signal math (sigma, bps, z≥3, n≥60, first-fire):
- **(D) 15m loss-rate by entry-tLeft:** final ≤60s = **0.39%**, 60–120s = **0.00%**, 120–180s = **1.09%**, 180–240s = 0.45%, 240–300s = 0.43%. Overall 15m ≈ **0.43%** signal loss rate — **non-zero**. The riskiest 15m sub-zone is tLeft 120–180.
- The single live 1h loss = `BTC 1h, ask 0.99, bps 38.64, z 3.11, tLeft 600` — a **strong** move (z passed) that reversed with **10 min** left. 15m's deep window caps at **tLeft=300** (half that reversal room), and the z-gate normalises by `√tLeft`, so 15m needs less.
- **Honest conclusion:** reversals CAN happen on 15m (latent ~0.4%), so "15m never loses" is only true because (a) the sample is small — at 0.43%, expected losses in 86 fills ≈ 0.37, so **0 live losses is the most-likely outcome, i.e. luck-consistent, NOT proof of immunity** — and (b) the **fill-filter** removes most reversible signals (cheap deep asks vanish; only converged/confirmed 0.97–0.99 asks fill late). The 1h loss hurt mainly because **1h fills are large deep-book trades** ($29.72 = ~129 wins to recover), whereas 15m fills are small. So the 1h mechanism is *muted* on 15m, **not absent**. Treat 15m as low-loss-rate, not zero.

### Q-C — Are we too tight? Can we increase fills? NO meaningful safe 15m loosening exists
- **15m FINAL (bps≥10) is already the loose, validated end.** Live: 71 final fills, **71W/0L, 53 of them at bps 10–15**. Backtest final loss rate 0.39%. Going below bps 10 admits sub-0.1% "leads" that pass z≥3 only because `√tLeft` is tiny near close — fragile noise; untested. Not a safe free lever.
- **15m DEEP (bps≥25) is FILLABILITY-capped, not bps-capped.** Backtest at bps≥25 throws ~2,752 deep signals over the period, but **live only filled 15** deep trades — because deep asks are mostly >0.97 (unfillable at the 0.97 cap) or convert to a later final fill. So **lowering deep bps 25→20 adds essentially NO fills** (they won't fill), while backtest shows the deep loss rate is ~0.5% **at every bps gate 15→30** (losses span bps 20–168, NOT removed by 25). No fill upside, small risk add → **don't loosen**.
- **The binding constraint on 15m fills is FILLABILITY (winner asks vanish near close — B5/B8) + market volatility, NOT our gate.** Per-UTC-day live fills: pre-tightening 12/17/9/18/19/23 (of which **1h contributed 5/6/5/5/7/14**); post-tightening 3/7/6/5/9 — **all 15m, 1h=0 every day**. So the pre-tightening 9–23/day **required the 1h lane**, which is the large-loss lane. A 15m-only safe gate ceiling is ~**6–10/day** (volatility-driven), and we are already at it.
- **RULE-ZERO catches this pass:** (1) the in-code gate-calibration **comment is not reproduced** by the independent backtest — "1h losses all at tLeft>180 / 0 at 60–120" is FALSE here (1h loss rate is flat ~0.16% across deepMax 120→600), and "3 15m-deep losses at bps 20–24 removed by 25" is FALSE here (deep losses persist at bps≥30). The comment's numbers should NOT be trusted as the justification; the tightenings remain defensible on **loss-SIZE + fill-reality + the real tLeft=600 live loss** grounds instead. (2) **`scripts/v36-gate-survival.js` is STALE** — it models 15m-final `bps≥15` while live runs `bps≥10`, so it over-counts kills; recompute with bps≥10. (3) My backtest **ends 06-12, so the real 06-19 1h live loss is OUTSIDE it** — the backtest UNDER-states tail risk and must not be used to argue for reopening 1h. **Keep 1h `deepMax=120`.**

### Verdict + the only testable idea
**We are not meaningfully "too tight" on 15m, and there is no free safe way to raise fills.** The honest levers: (a) **more bankroll** — already done via the deposit (the clean accelerator, no per-trade risk add); (b) accept that fills/day is a volatility-driven distribution (~6 typical, 3–10 range); (c) the **only** loosening that is even arguable is 15m-final `bps 10→8`, but it admits fragile sub-0.1% near-close leads and is untested → **shadow-only via the forward recorder before any live change, not a blind flip.** Reopening 1h or adding 5m raises loss/variance/strand risk and is rejected under the operator's min-loss priority unless a fill-aware ≤24h shadow proves otherwise.

### Q-D — Deposit + timeline (PROJECTED, honest, no-further-loss path)
At **$34.27** with `fEff≈0.84` and per-fill edge ~0.93% (blended ~1.0–1.3% with the 24% cheaper fills), compounding to **+$100 profit ($134)**: **~6/day ⇒ ~25–30 days**, ~9/day ⇒ ~17–20 days (PROJECTED). The deposit roughly **halved** the time-to-target vs $14 (~38–50 days). **$100 in 7 days remains impossible** (needs ~45–60 fills/day vs the ~3–10 the gate supplies). One deep loss at $34 sizes to ≈$28 (15m books are shallower, so realized 15m loss is smaller) and the Policy-B guard leaves ≈$5.5 floor — **survivable, not bust**, but would set back ~weeks; the ~0.4% 15m rate keeps that tail low.

### Premortem / recorder / backup / backstop
- **Premortem (assume bankroll halved in 2 weeks — cause?):** most likely a first-ever **15m reversal** (the latent ~0.4%) landing on a large $34-sized fill, or a small cluster near the floor. Bounded by z≥3 / final-bps≥10 / deep-bps≥25 / ask≤0.97(deep) / Policy-B floor guard. No new structural trap found.
- **Forward recorder:** still **DOWN** locally (last wrote 06-25 16:33). Durable always-on needs the operator to run `powershell -ExecutionPolicy Bypass -File scripts\install-collector-autostart.ps1` on the always-on PC (agent env can't register the task). Required for any 15m-final-bps shadow.
- **Backup:** current; no secrets/config changed this pass.
- **Backstop `node scripts/v36-forensic-audit.js`:** **22 PASS / 5 WARN / 0 FAIL**; constants parsed from source unchanged (FEE 0.072, floor 5.5, f 0.85, FOK); live loss-rate 95% CI upper ≈ **2.44%** (NOT zero); gate keeps ~63% of historical rate; $100/7d impossible.

**Bottom line for the operator:** (1) "buy cheaper" isn't a free knob — we already harvest the cheap fills (24.2% sub-0.99) and forcing more means earlier entry = real reversal risk; leave it. (2) The 1h loss mechanism is **muted but not absent** on 15m — 15m has a ~0.4% latent loss rate (0 live losses is luck-consistent, not immunity), kept ~0 by short horizon + the fill-filter; the 1h loss hurt because 1h fills are big. (3) We are **not meaningfully too tight on 15m** — final is already at the loose validated `bps≥10`, deep is fillability-capped, so loosening adds ~no fills and some risk; the pre-tightening 9–23/day needed the risky 1h lane. (4) The clean accelerator is the **deposit you already made** — at $34 the path to +$100 roughly halves to ~25–30 days at 6/day. **Recommendation: keep the config; if you want to push, the only candidate is a recorder-based shadow of 15m-final bps 10→8 — say the word and I'll set it up.**

---

## 13T. OPERATOR Q&A PASS — 60–120s ZONE?, REOPEN 1h/5m "NEAR-0-LOSS"?, CAN WE INCREASE FILLS?, "14 FILLS TODAY" (2026-06-25, ~22:30 local)

Follow-up to §13S. Operator asks: (Q1) since 15m 60–120s showed 0.00% loss, should we restrict entry there, and would it change profit/timeline?; (Q2) can 1h be reopened with a config that still trades but is ~0-loss like 15m, AND profits?; (Q3) same for 5m?; (Q6) "surely there must be a way to increase fills"; (Q7) "we are currently 14 fills today." Full protocol: live re-pull, char-by-char gate+sizing read (`lib/snipe-strategy.js` L998-1050), fresh ledger recompute, an extended per-second backtest now covering **5m+15m+1h with Clopper-Pearson CIs**, EV-vs-break-even by ask, a size-cap drawdown model, and a live **net-P&L-by-timeframe** computation. **No trading logic/config changed; nothing deployed.** New scripts: `scripts/v36t-fills-and-config-explorer.js`, `scripts/v36t-1h-pnl.js`.

### Live state re-pulled (primary)
`mode=LIVE, snipe.enabled=true, paperMode=false`, not paused/halted, `sigType=3`. **Bankroll $34.9972** (`sizingSource=live-refreshed-wallet`), `fEff=0.8428`, `floor=$5.5`, `K=2`, `allowedTimeframes=[15m,1h]` (`supportedTimeframes` includes 5m, currently OFF). `snipe.settled=236, wins=235, losses=1` (was 234 at §13S ~1.5h earlier). Single live loss still the one BTC 1h. The bot's HTTP surface (`/api/status`, `/api/trades`, `/api/diagnostics`) does **NOT** expose per-day snipe fills (snipe keeps its own `/data/snipe` ledger), so "14 today" is the operator's read of live Polymarket activity, reconciled below. Always re-pull `/api/status`.

### KEY new lens: BREAK-EVEN loss rate by entry ask (fee coef 0.072) — this reframes the whole question
| entry ask | win pays (of cost) | break-even loss rate |
|---|---|---|
| 0.95 | 5.26% | **4.66%** |
| 0.97 | 3.09% | **2.79%** |
| 0.98 | 2.04% | 1.86% |
| 0.99 | 1.01% | **0.93%** |

**The cheaper the ask, the more loss rate it tolerates.** A 0.97 deep fill survives a 2.79% loss rate; a 0.99 fill only 0.93% — **~6× the safety margin**. This is WHY 15m-deep@0.97 is structurally safe and 1h@0.99 is thin-margin: it's the ASK, not the timeframe.

### Q7 — "14 fills today": reconciled + RULE-ZERO correction of §13S
OBSERVED per-UTC-day live fills (backup ledger through 06-24): TOTAL **12,17,9,18,19,23,3,7,6,5,9** → min 3, max 23, mean 11.6, med 9 (pre-tightening had 5–14 1h/day). **15m-only: min 3, max 13, mean 7.8, med 7** (the 11–13 days were high-volatility). The forensic audit independently projects **8.0/day** under the current gate. **Today's 14 is a new high, just above the prior observed max of 13** — fully consistent with a high-volatility day under the looser final gate (`bps≥10`, reverted 06-21). **CORRECTION:** §13S's "typical 6, range 3–10" **understated** it. Honest figure: **15m-only ≈ mean 8, median 7, range ~3–14, volatility-driven.** 14 is a good day, not the norm — do not bank on it.

### Q1 — Restrict 15m to 60–120s? NO — that zone fills ZERO trades live
- **The 60–120s zone produced 0 of 86 live 15m fills.** Live 15m-deep fills (15) by tLeft: **61–120 = 0, 121–180 = 1, 181–300 = 14.** It is a structural **dead zone**: by 60–120s the winner ask has already converged to ~0.99 (rejected by the 0.97 deep cap), but it isn't yet the ≤60s final window (cap 0.99). So **restricting entry to 60–120s = the bot stops trading 15m almost entirely.**
- The 0.00% there is a small-sample artifact (877 backtest signals, **Clopper-Pearson 95% CI [0%, 0.42%]**) — statistically indistinguishable from the final window's 0.389%. **No proven safety gain.**
- Where the fills actually are: **final ≤60s (71 fills, 0.389% loss, @0.99)** + **deep 181–300 (14 fills, @≤0.97, 2.79% break-even = huge margin)**. We already take the safest fills.
- **Effect on profit/timeline: strictly worse** — fills collapse toward ~0, growth stops, for no safety gain. **Keep current windows.**

### Q2 — Reopen 1h "near-0-loss like 15m" AND profit? NO — 1h is a LIVE NET LOSER (decisive)
- **Live net P&L by timeframe (deduped): 15m = 86W/0L NET +$10.36; 1h = 41W/1L NET −$25.11.** The 41 1h wins made only **+$4.61** total (1h wins are tiny at 0.99, ~$0.11 each); the single loss was **−$29.72**. **The 1h lane has LOST money live — ~209 average 15m wins to recover what 1h's one loss cost.** Reopening it is the opposite of a profit-add.
- **You can't get 1h fills without the dangerous window.** 37/42 (88%) of live 1h fills entered at **tLeft 301–600** (the wide window, incl. the −$29.72 at tLeft=600). The deployed tight `(60,120]` window filled only **4 times ever**, **0/day since tightening** — so "1h that trades" REQUIRES widening back toward `(60,600]`, the exact large-loss lane.
- **You can't window-away the loss.** Independent backtest: 2 losses sit **exactly at the t=120 boundary** (BTC bps42.9/z3.91, BNB bps37.9/z4.17), so reversals strike even at the tight edge. (RULE ZERO: contradicts the in-code "`(60,120]→1257W/0L`" comment — trust the data.)
- **Loss rate straddles break-even & is uncertain:** backtest `(60,120]` = 0.16% (CI [0.02%, 0.58%], +EV) vs **live = 2.38% (CI [0.06%, 12.57%], −EV)**; break-even at 0.99 = 0.93%. We do not actually know if 1h clears break-even — and the live record says it didn't.
- **Size-cap bounds BUST risk, not EDGE.** At $35/f=0.85: uncapped 1h loss $29.70 (**85% DD**, near-bust); cap 10sh $9.90 (28%); cap 5sh $4.95 (14%). But **wins-to-recover is invariant (~107)** — a cap makes a loss survivable, it does NOT turn a negative/uncertain edge positive. Even capped, the live 41W/1L record stays net-negative.
- **Verdict: keep 1h effectively OFF (the tight window is correct).** It fights priority #1 (it has literally lost money). Not recommended even with a size cap, except as a no-money shadow if you ever want to retest the edge.

### Q3 — 5m? Real edge, but fillability-capped (~1/day) — only a minor safe add
- Backtest (8,696 5m cycles, deployed gate): **total loss rate 0.227%** — actually **LOWER than 15m's 0.432%**. Per-window EV: **deep@0.97 = +2.87%/fill** (CI-hi loss 0.43% « 2.79% break-even = fat margin), **final@0.99 = +0.56%/fill**. 5m's edge is REAL and its deep window is as safe as 15m-deep.
- **RULE-ZERO flag:** the Standing Ledger's "5m ~1.8× riskier than 15m" does **NOT reproduce** here on gated loss rate (5m is lower). That older figure was a different ("decisive-lead flip") metric.
- **The real limiter is FILLABILITY.** 5m deep asks are usually >0.97 (unfillable at the cap) and the final window is tiny (≤30s non-BTC) with thin books — historically ~1/day fillable. Enabling 5m (its 0.97 deep cap protects it) adds maybe **~1–2 fills/day**, low-risk, +EV — a small, safe booster, not a needle-mover. Needs a fillability shadow before enabling; no live 5m fill data exists yet.

### Q6 — "Surely there's a way to increase fills?" — honest ranked menu
1. **More bankroll** — already done (the deposit). No per-trade risk; doesn't add fills but compounds faster. The clean accelerator.
2. **Enable 5m with a size cap** — the only *safe* fill-adder, but ~1–2/day and fillability-limited. Test fillability first.
3. **Widen 1h (±size cap)** — biggest raw fill lever (~5–14/day) BUT the **net-loser lane**; rejected under min-loss priority.
4. Accept that **15m fills are volatility-driven (3–14/day, ~8 mean)** — today's 14 is the upside tail.

**The binding constraint is FILLABILITY (winner asks vanish near close — B5/B8), not our gate** — so loosening the gate adds ~no fills; only ADDING a fillable timeframe (5m) helps, and it must stay size-capped/cheap-ask to stay safe.

### RULE-ZERO corrections logged this pass
- §13S "typical 6, range 3–10" → corrected to **mean ~8, median 7, range ~3–14** (audit projects 8.0/day; today's 14 is the tail).
- §13S floated **15m-final `bps 10→8`** as "the only candidate." The break-even analysis now shows final@0.99 has **EV@CI-hi only +0.216%**, so loosening to bps 8 risks crossing into −EV. **Withdrawing that suggestion** — it is NOT a safe lever; the safer experiment is 5m fillability instead.
- Backtest 1h `(60,120]` = 0.16% (+EV) but **live 1h is net −$25.11**; **trust the live primary data.** Backtest ends 06-12 (excludes the 06-19 loss) so it UNDER-states 1h tail risk.

### Premortem / recorder / backup / backstop
- **Premortem:** likeliest 2-week damage = a first-ever 15m reversal (latent ~0.43%) on a large fill, or a cluster near the $5.50 floor — bounded by z≥3 / bps gates / ask≤0.97(deep) / Policy-B. Reopening 1h would be the fastest way to recreate the −$30 event — another reason to keep it off.
- **Forward recorder:** still **DOWN** locally (agent env can't register the autostart task). For any 5m/maker shadow, run `powershell -ExecutionPolicy Bypass -File scripts\install-collector-autostart.ps1` on the always-on PC.
- **Backup:** current; no secrets/config changed.
- **Backstop `node scripts/v36-forensic-audit.js`:** exit 0, **22 PASS / 5 WARN / 0 FAIL**; constants parsed from source unchanged (FEE 0.072, floor 5.5, f 0.85, FOK); **projects 8.0/day**; loss-rate CI nonzero; $100/7d impossible.

**Bottom line for the operator:** (1) **Don't move to 60–120s** — that zone fills 0 trades live (dead zone); we already take the safest fills (cheap 0.97 deep + 0.99 final). (2) **Don't reopen 1h** — live it is **41W/1L but NET −$25.11**; its fills only exist in the wide reversal window, its loss can't be zeroed (losses hit even at the t=120 edge), and at 0.99 the tiny wins can't cover one loss; a size cap makes a loss survivable but can't make the edge positive. (3) **5m** has a genuine edge but fills ~1/day — a small, safe booster at best. (4) **There is no big *safe* fill lever**: fills are fillability-limited; the honest accelerators are the bankroll you added + accepting 15m runs ~3–14/day (~8 mean). (5) Timeline: at ~$35, +$100 profit ≈ **~20–30 days at ~8/day** (faster on hot days, ~25–30 at 6/day); **$100/7d still impossible**.

---

## 13U. OPERATOR PASS — TELEGRAM SNIPE-STATUS FIX, 5m + 0.95 SHADOWS, LOSS ANATOMY ("where/why/how did each loss happen, will it recur?"), COLLECTOR ON (2026-06-25, ~23:15 local)

Follow-up to §13T. Operator asked: (A) **fix the Telegram "snipe status" button — clicking it sends nothing**; (B) make the Telegram status/dashboard **nicely presented** and check everything is correct; (C) **make the 5m shadow** and a **0.95 shadow** ("has 0.95 actually lost in the backtests?"); (D) **run the collector** to record everything; (E) for **every loss-rate %**: *where, why, when, HOW did it lose, can it be mitigated, can it recur, will it actually happen?* Full protocol run: live re-pull, char-by-char gate read (`snipe-strategy.js` L998-1050), and **three new scripts** built this pass: `scripts/v36u-loss-anatomy.js` (every backtest loss enumerated), `scripts/v36u-realask-fill.js` (the 5m + 0.95 shadow over the real CLOB tape), `scripts/v36u-telegram-render-check.js` (proves the fixed message is valid Telegram HTML). **One code fix made (`lib/telegram-commands.js`); NOT yet deployed (needs redeploy to reach the live bot). No trading logic/config changed.**

### Live state re-pulled (primary)
`mode=LIVE, snipe.enabled=true, paperMode=false`, not paused/halted, `sigType=3`. **Bankroll $34.9972** (`sizingSource=live-refreshed-wallet`), `fEff=0.8428`, `floor=$5.5`, `K=2`, `allowedTimeframes=[15m,1h]` (5m supported, OFF). `snipe.settled=236, wins=235, losses=1` — single live loss still the one BTC 1h. **Forward collector is now RUNNING locally** (see §13U-D), so the "recorder DOWN" flag from §13R-T is cleared for this session. Always re-pull `/api/status`.

### 13U-A. TELEGRAM "SNIPE STATUS" BUG — ROOT-CAUSED to a single character, FIXED + verified
- **Root cause (traced char-by-char, RULE ZERO):** `cmdSnipe()` built the line `Slots: K=2 | 🛑 LIVE emergency stop < $5.50` with a **literal unescaped `<`**. `replyText()` sends with `parse_mode:'HTML'` (L284). Telegram's HTML parser rejects any `<` that is not a valid tag → returns **HTTP 400 "can't parse entities"** → the message is **silently dropped**. The callback still answered ("Snipe status sent" toast), so to the operator it looked like "I click it and nothing is sent." This is the EXACT symptom.
- **Why only this button broke:** a scoped regex (`<` not forming a tag) across `telegram-commands.js` found **exactly one** such `<` — in `cmdSnipe`. Every other message (dashboard, balance, hyper, help) had none, so they worked. The `<` only fires when `minBankrollFloor` is finite — i.e. **always in LIVE** — so the snipe button was broken every time. Primary in-repo proof of the mechanism: the codebase's own `escHtml()` deliberately escapes `<`/`>`/`&` (and `cmdHelp` writes `&amp;`), precisely because Telegram HTML requires it.
- **Fix (`lib/telegram-commands.js` L1253-1278):** removed the literal `<` (now `🛑 floor $5.50`), `escHtml`-escaped every dynamic field (`mode`, `stateDir`, `lastError`, open/pending entries), and improved the layout (status emoji, timeframes, W/L + win-rate). **Verified:** `node scripts/v36u-telegram-render-check.js` renders the message from the REAL live status and validates **0 stray `<`, 0 stray `>`, 0 non-entity `&` → PASS** (Telegram will no longer 400).
- **Rest of Telegram swept:** `getDashboardLines()` (the dashboard/status text) and the strategy/executor notification builders already `escHtml` their dynamic content and contain no stray `<`. So the surface is now clean; the snipe button was the lone offender.
- **ACTION REQUIRED:** this fix is in the source only. The live bot on `polyprophet-live.fly.dev` keeps the old (broken) message until a **redeploy** (`fly deploy`). Until then, `/snipe` and the 🎯 Snipe Status button stay broken on the live bot.

### 13U-E. LOSS ANATOMY — every backtest loss enumerated (`v36u-loss-anatomy.js`, deployed gate, 2026-05-20→06-12, 8,776 fired cycles)
For each loss-rate figure, the **mechanism is identical**: the bot buys the side that has moved decisively (z≥3, bps over the floor); a *loss* is when that move **reverses back across the cycle-open before settlement**. The script records every loss's entry move → peak → FINAL (flipped sign). Break-even by ask: **0.95→4.66%, 0.97→2.79%, 0.99→0.93%.**

| tf | fired | losses | rate (95% CI) | WHERE the losses are | WILL it recur? |
|---|---|---|---|---|---|
| **5m** | 2204 | 5 | **0.227%** [0.07,0.53] | **ALL 5 in the FINAL ≤0.99 window** (tLeft 28-60s); **deep ≤0.97 = 0/853** | yes, ~1 in 440; final-only |
| **15m** | 5322 | 23 | **0.432%** [0.27,0.65] | 13 deep (≤0.97), 10 final (≤0.99) | yes, ~1 in 230 |
| **1h** | 1250 | 2 | **0.160%** [0.02,0.58] | **both at tLeft=120 — the exact tight-window edge** | yes (excl. the real 06-19 loss) |

- **HOW/WHY (concrete):** the worst losses are **big decisive moves that violently reverse**. The 15m deep losses **cluster on a single day, 2026-06-05** — a correlated all-asset reversal (e.g. ETH entered +168bps, peaked +215bps, then closed −33bps = a 201bps reversal; same on BTC/SOL/XRP/DOGE within minutes). The final-window losses are smaller late wobbles (14-50bps). The 1h backtest losses (06-10, BTC +42.9bps/z3.91 and BNB +37.9bps/z4.17) sit **exactly at tLeft=120s**, proving reversals strike even at the tightened 1h edge.
- **CAN it be mitigated? (the key answer):** **the PRICE is the mitigation.** A win at 0.97 pays 3.1% so it survives a 2.79% loss rate (5.9× margin vs the 0.47% deep rate); at 0.95 it survives 4.66% (≈10× margin). So the cheap deep lane is **structurally safe despite the losses** — they're far too rare to make it unprofitable. What you **cannot** mitigate to zero: the *event itself* (06-05-type correlated reversals) — it WILL recur. Mitigations that work: cheap ask (margin), **small size** (15m fills are small), the Policy-B floor guard, and **keeping 1h off** (1h fills big at 0.99 → one reversal = catastrophic, which is why 1h is the live net-loser).
- **WILL it actually happen?** Yes — these are real, non-eliminable rates. Honest framing: **15m "loses rarely" (~0.43%, ~1 per ~230 fills), it is NOT lossless.** 0 live 15m losses in 86 fills is luck-consistent (expected ≈0.37), not immunity. The danger scenario is a *cluster* (06-05 had ~6 in one day); at $34 with small 15m sizing that is a multi-week setback, **not a bust** (floor guard leaves ≈$5.5).
- **RULE-ZERO (re-confirmed):** the in-code comments **L1014** ("the 3 15m-deep losses all had bps 20-24, so 25 removes them") and **L1002** ("1h 60-120 → 1257W/0L") **do NOT reproduce** — deep losses span bps 25-168, and 1h tLeft=120 shows 2 losses. The gate is still correct, but for **loss-size + fill-reality + the real tLeft=600 live loss** reasons, NOT those comment figures. Backtest ends 06-12 ⇒ excludes the 06-19 live 1h loss ⇒ under-states 1h tail.

### 13U-C. THE 0.95 SHADOW — "has 0.95 lost?" The decisive, two-sided answer (`v36u-realask-fill.js` on the real 06-25 CLOB tape)
This is the most important finding of the pass and it **reframes the whole "buy cheaper at 0.95" idea**:
- **GATED (backtest, with z≥3):** a ≤0.95 ask only exists EARLY/deep, and the deep window's **gated** loss rate is **15m 0.472% / 5m 0.000%** — both ~10× under the 4.66% break-even. So a *gated* 0.95 fill is hugely +EV. ✅
- **UNGATED (real tape, today):** buying the cheap leading side at ≤0.95 in the deep window **WITHOUT the confidence gate lost 15 of 32 (~47%)** — `5m deep ≤0.95 = 25 fills, 44% win`; only `15m deep ≤0.95 = 7 fills, 85.7%`. ❌ That blows through break-even.
- **WHY the gap, and the lesson:** a cheap (≤0.95) ask exists in the deep window **precisely because the market isn't confident yet** — and when it isn't, the outcome is near a coin-flip. **It is the z≥3 confidence gate, NOT the cheap price, that makes a cheap fill safe.** The live bot's nice 0.96-0.98 fills are safe only because they *also* passed z≥3 (cheap AND confident — rare). So: you **cannot manufacture more cheap fills** by lowering the price cap; doing so without the gate is a coin-flip, and *with* the gate it just **rejects** the 0.96-0.99 gated fills you currently win → **fewer trades, not cheaper ones.** Verdict: **keep the cap+gate as-is; do NOT add a naked 0.95 lane.** (This corroborates §13R/§13S with hard real-ask data.)

### 13U-C2. THE 5m SHADOW
- **GATED backtest:** 5m deep ≤0.97 = **0 losses / 853** (as safe as 15m-deep); the only 5m losses are 5 in the final ≤0.99 window (0.37%). So 5m's edge is real and its deep lane is safe at the cheap cap.
- **Real-tape fillability (06-25):** 5m final ≤0.99 won 13/14 (92.9%); 5m deep is cheap but (ungated) coin-flippy — same lesson as 0.95: 5m must keep the gate + the 0.97 deep cap. Historically ~1-2 fills/day, fillability-limited.
- **Status:** the collector now records 5m every second, so the **going-forward 5m shadow is live** — re-run `v36u-realask-fill.js` after 24h for a robust read before any decision to enable 5m.

### 13U-D. COLLECTOR — RUNNING NOW (records everything)
Started `node scripts/run-forward-collector-supervised.js` (env `FORWARD_COLLECTOR_TIMEFRAMES=5m,15m,1h,4h`, all 7 assets). Confirmed **writing**: 26 ACTIVE crypto up/down markets, `saved=26 failed=0` every second, `compress=true`, `collectSpot=true`, into `data/forward-second-clob/2026-06-25/`. It is read-only/public-API (no secrets), off the trading box, supervisor relaunches on crash. **For persistent 24h+ collection on the always-on PC** (the agent session ends at submit), run once: `powershell -ExecutionPolicy Bypass -File scripts\install-collector-autostart.ps1` (registers an at-logon Scheduled Task). The two shadow analyzers (`v36u-realask-fill.js`, and `analyze-forward-second-clob.js`) read the resulting tape directly.

### Verdict / recommendation
1. **Deploy the Telegram fix** (`fly deploy`) — it's verified but only lives in source until redeployed; `/snipe` + the button stay broken on the live bot until then.
2. **Keep the snipe config exactly as-is.** The loss anatomy + the 0.95 real-ask shadow both confirm: cheap fills are already harvested, and a naked 0.95/earlier lane is a coin-flip (safe only behind z≥3). 1h stays off.
3. **Let the collector run 24h**, then re-run `v36u-realask-fill.js` for a robust 5m/0.95 read before any change. 5m is the only safe *potential* fill-adder (~1-2/day), and only size-capped/cheap-ask.
4. **Timeline unchanged (PROJECTED):** at ~$35 and ~8 fills/day, +$100 profit ≈ **~20-30 days**; **$100/7d remains impossible** (~45-60 fills/day needed; market gives ~3-14).

### Backstop / backup
- `node scripts/v36-forensic-audit.js` → **22 PASS / 5 WARN / 0 FAIL** (the 5 WARNs are the standing honesty items: projected≠observed fills/day, historical-rate cut >20%, loss-rate CI nonzero, $100/7d impossible). Constants parsed from source unchanged (FEE 0.072, floor 5.5, f 0.85, FOK).
- Backup current; **no secrets/config/trading-logic changed** this pass — only the Telegram message builder and three new read-only analysis scripts.

---

## 13V. STREAMER VIEW — money-free screenshot mode (built by the prior session; VERIFIED this pass)

The previous chat (the one that OOM-crashed) had **already implemented** a money-free Telegram "Streamer View" for screenshots/streaming. This pass verified it end-to-end; it only needs a redeploy to reach the live bot.

- **What it is:** `cmdStreamer()` in `lib/telegram-commands.js` (L1287-1311) — a deliberately money-free snipe snapshot. Wired three ways: the `🎬 Streamer View` button on the control keyboard (L130), the `/streamer` + `/snipe_streamer` commands (L1676-1677), and the `pp_streamer_status` callback (L1743). The full money view stays on `/snipe`.
- **Proven screenshot-safe (RULE ZERO):** `node scripts/v36v-streamer-render-check.js` renders the message from the REAL live `/api/status` and asserts (1) valid Telegram HTML (no stray `<`/`>`/`&` → no HTTP-400) and (2) NO money — no `$`, and none of bankroll/accounting/stake/f_eff/floor/shares/profit/P&L. **Result: PASS** on both, against the current live state.
- **Exactly what it renders (from the live bot, this pass):**
  ```
  🎬 [POLY] SNIPE — STREAMER VIEW
  🟢 ENABLED | mode LIVE | timeframes 15m, 1h
  📈 Record: 244 settled — ✅ 243W / ❌ 1L (99.6% win rate)
  📂 Open now: none
  🎯 Near-certainty crypto up/down snipe — fires in the last seconds before each market closes.
  🔒 Balance & P&L hidden for streaming. Use /snipe for the full money view.
  ```
- **Status:** in SOURCE only — the live bot keeps the old menu until a **redeploy**. After redeploy, tap **🎬 Streamer View** (or send `/streamer`) for the money-free snapshot. (It shows the W/L record because the 99.6% win-rate is the brag and it leaks no money; if you want the single `1L` hidden too so it shows wins ONLY, that is a one-line change — say the word.)
- **Telegram snipe-status bug (§13U) also confirmed fixed in source** (`cmdSnipe` no longer emits a literal `<`; `v36u` render-check PASS) — it ships on the same redeploy.

---

## 13W. OPERATOR PASS — LOSS WAS 1h NOT 15m (RE-VERIFIED), CHEAPER-BUT-GATED, FORWARD DATA, CORRUPTION SWEEP, CLEANUP + BACKUP, DEPLOY (2026-06-26, ~11:30 local)

Full MASTER PROTOCOL pass for the operator's questions: (1) the loss was **1h, not 15m** — prove it; (2) can we go **cheaper but gated**, is it better; (3) is the **forward collector** still running + analyse its data; (4) **redeploy** + the **streamer mode**; (5) **storage cleanup** tier-1 list incl. forward collections; (6) **new backup**, delete old; (7) **GitHub** + a **friend setup guide**. Manual char-by-char read of the live trading path (`snipe-strategy.js` gate L998-1050 + Policy-B guard L447-460); live parity from `polyprophet-live.fly.dev`; authoritative recompute from the freshest local ledger (`debug/live_ledger.jsonl`, 06-26 10:31). New script: `scripts/v36w-ledger-audit.js`.

### Live state re-pulled (primary — `polyprophet-live`)
`isLive=true`, `snipe.mode=LIVE`, `enabled=true`, `paperMode=false`, not halted. **Bankroll $38.553** (`sizingSource=live-refreshed-wallet`), `f=0.85`, `fEff=0.85` (Policy-B; nominal f binds well above the floor), `K=2`, `floor=$5.5`, `[15m,1h]`, `settled=244 (243W/1L)`, `lastError=NO_FILL_AFTER_RETRIES` (benign). **Always re-pull `/api/status`.**

**RULE-ZERO catch (resolved before stating it as fact):** the `/api/health` surface shows `leadlagOnlyMode:true / stakeFraction 0.15 / hardEntryPriceCap 0.95 / polyprophet-lite-1.0.0`, which LOOKS like it contradicts the SNIPE config. It does NOT — that is the **dormant legacy lead-lag orchestrator profile**; the SNIPE that actually trades lives in `/api/status.snipe` and reads `f=0.85, K=2, floor 5.5` (verified). `LEADLAG_ENABLED=false`, `WINNER_ENABLED=false` in `fly.toml`; the ledger is SNIPE-only; `polyprophet-lite-1.0.0` is just the root `package.json` name. The README's SNIPE description is accurate.

### Q1 — The loss was 1h, NOT 15m (operator is correct; 15m has NEVER lost live)
Authoritative recompute from the freshest ledger (`debug/live_ledger.jsonl`, 06-26 10:31, via `scripts/v36w-ledger-audit.js`), deduped by `tf:asset:epoch:side`:
- **LIVE total: 144W / 1L** (99.31%).
- **15m: 103W / 0L — NET +$15.5734.** 15m has **0 live losses, ever.**
- **1h: 41W / 1L — NET −$25.1074** (41 wins made only +$4.614; the one loss was −$29.7214).
- **The single live loss (OBSERVED):** `BTC 1h, side=down, ask=0.99, 30 shares, bps=38.64, z=3.11, tLeft=600, pnl=−$29.7214`. `tLeft=600 > deepMax1h=120`, so the deployed 1h gate already removes this exact entry.
- **RULE-ZERO clarification of the "~1 in 230" figure:** that number is the **15m BACKTEST loss rate** (23 modelled losses in 5,322 fired backtest cycles ≈ 0.43% ≈ 1/230; §13U-E) — a **PROJECTED latent rate, NOT a live 15m loss.** OBSERVED live 15m = **0 losses in 103 fills** (0 is luck-consistent with a ~0.43% latent rate, expected ≈0.44, so 15m is "low-loss, not proven-immune"), but it is categorically **wrong to say 15m "loses ~1 in 230" live.** OBSERVED (15m 0L) and PROJECTED (backtest ~0.43%) are kept strictly separate. The only live loss mechanism is the now-gated-out 1h deep-window reversal.

### Q2 — "Cheaper but gated": you ALREADY have it, it's good, and you can't get MORE of it for free
- **Break-even loss rate by entry ask** (fee 0.072·p·(1−p)): 0.95→**4.66%**, 0.97→**2.79%**, 0.98→1.86%, 0.99→**0.93%**. Cheaper ask ⇒ far more loss-rate tolerance (a 0.97 fill has ~6× the margin of a 0.99 fill). It is the ASK, not the timeframe, that drives safety.
- **OBSERVED (freshest ledger):** **43 of 145 live fills (29.7%) already fill cheaper than 0.99** (0.98×14, 0.97×9, 0.96×13, 0.95×2, plus a 0.93 and a 0.90 15m-final bargain) — all having passed `z≥3`. A cheaper ask buys MORE shares for the SAME `f·B` cost ⇒ **identical downside, ~3× the win profit at 0.97 vs 0.99.** The deep-15m cap is already the tighter/safer **0.97**.
- **Can we force cheaper fills? No (and §13U-C proved why with real tape):** GATED ≤0.95 (with z≥3) is hugely +EV (15m deep 0.472% / 5m 0.000% loss, ~10× under the 4.66% break-even), BUT a cheap ask exists in the deep window *because the market isn't confident yet* — buying ≤0.95 **UNGATED** lost **15 of 32 (~47%)** on real tape. It is the **z≥3 confidence gate, not the cheap price, that makes a cheap fill safe.** Lowering the price cap doesn't create cheaper trades — it just **rejects** the 0.96-0.99 gated fills we currently win (fewer trades, not cheaper ones). **Verdict: keep cap+gate exactly as-is; the ~30% cheaper gated fills are a free bonus already captured. It is strictly better than a fixed-0.99 lane and we are already getting it.**

### Q3 — Forward collector: NOT running now; data exists; needs operator autostart for a durable 24h tape
- **Status (proof, not assumption):** no `node` collector process is running on this box; it last wrote at **~10:36 today** then stopped (each agent/chat session's collector is transient and dies with the session — same finding as §13P-U).
- **Data gathered so far:** `data/forward-second-clob/2026-06-26` = **2.5 GB across 939 per-cycle `.jsonl` files** (e.g. `bnb_15m_<epoch>.jsonl` — full per-second CLOB depth ladders + spot for all assets/timeframes); `2026-06-25` = 32 MB / 253 files. Structure verified intact. This is exactly the tape the maker/5m/cheaper-ask shadows need — but a useful experiment needs a **continuous 24h** tape, which keeps getting cut short because the recorder is not durably auto-started.
- **OPERATOR ACTION (one-time, on the always-on PC):** `powershell -ExecutionPolicy Bypass -File scripts\install-collector-autostart.ps1` registers an at-logon Scheduled Task so the recorder survives restarts. The agent environment cannot register that task (access denied), so the operator must run it. Until then, no fresh 24h tape persists.

### Corruption sweep (operator's storage-crash worry) — CLEAN
- **`node --check`: 0 failures** across `server.js` + **all** `lib/*.js` + **all** root `*.js` + **all** `scripts/*.js`. The live trading path and every script are syntactically intact.
- **JSON:** all `strategies/*.json` valid; the only anomaly was a **1-byte stray `.json`** file in root (junk — removed in cleanup), not a real file.
- **Ledger integrity:** `debug/live_ledger.jsonl` ends cleanly (not truncated); its single JSON-parse-fail is a harmless UTF-8 BOM on the first `START` record, not data loss.
- **Verdict: the storage crash did NOT corrupt the code or the strategy/config data.** (The previous chat's `OutOfMemoryError` was a heap error in the chat client, not file corruption on disk.)

### Code == live runtime (manual, this pass)
SNIPE gate `lib/snipe-strategy.js` L998-1050 read char-by-char: `deepMax 15m=300 / 1h=120 / 5m=120; deepMin1h=60; minBps deep 15m=25 / 1h=20 / 5m=30, final 15m=10 / other=20; z≥3; askCap deep-1h=0.99 / deep-other=0.97 / final=0.99; depth≥5; pays bestAsk, sweeps to cap only on big orders`. Policy-B guard L447-460 = `min(f, (B−floor)/B)` with the 5-share-min soft floor. **All equal the verified runtime** (live `fEff=0.85` reconciles to `min(0.85,(38.553−5.5)/38.553)`). ⇒ **redeploying this checkout changes NO trading logic** — it only ships the Streamer View + the Telegram snipe-status fix.

### Redeploy (requested) — SAFE, but the target needed correcting
- `fly.toml` said `app="polyprophet"` (the OLD, decommissioned app). The live bot is **`polyprophet-live`**. A naive `fly deploy` would hit the wrong app. **Fixed this pass:** `fly.toml` `app` → `polyprophet-live`. Deploy with `fly deploy -a polyprophet-live --remote-only` (Fly CLI is authed as `lingerslongers@gmail.com`).
- Bot has no open positions ⇒ safe deploy window. Post-deploy: re-pull `/api/health` + `/api/status`, assert new image == running machine and `snipe f=0.85/K=2/[15m,1h]`, and tap 🎬 Streamer View to confirm.

### Storage cleanup — TIER-1 list (frees the most, fastest)
| Item | Size | Action |
|---|---|---|
| `../POLYPROPHET_FULL_BACKUP_20260620/` (old backup; investigation-data reviewed) | **3.8 GB** | **DELETE** (operator-authorised; done this pass) |
| `data/forward-second-clob-condensed/` | 1.46 GB | delete if condensed history isn't needed locally (regenerable from tape) |
| `data/forward-second-clob/2026-06-26/` (today's raw tape) | 2.5 GB | keep until analysed, then gzip/delete (collector self-compresses ~20×) |
| `data/forward-second-clob-tape/` + `-tape-smoke/` | ~197 MB | delete (older/smoke tape) |
| `../POLYPROPHET-clob-fix-deploy/` + `../POLYPROPHET-main-push/` (sibling checkouts, outside repo) | ~477 MB | delete if not your active deploy copies |
| `epoch2/` + `epoch3/` (old experiment outputs) | ~34 MB | delete (superseded) |
| `telegram_ai_media_bot/` | ~38 MB | delete if the media bot is unused |
| `print/`, `research_archive/`, stale `debug/` snapshots, `.tmp-origin-review/` | ~25 MB | delete stale snapshots |
| **KEEP** | — | `data/binance-1s/` (147 MB backtest ground truth), `lib/`, `scripts/`, `strategies/`, `server.js`, the current backup |

### Backup — refreshed; old deleted
A new portable backup `POLYPROPHET_FULL_BACKUP_20260626/` was created (app code incl. the Streamer View + Telegram fix; secrets carried from the prior backup; state; RESTORE notes). It excludes the multi-GB `data/`, so it is small. The 3.8 GB `../POLYPROPHET_FULL_BACKUP_20260620` was deleted. **Operator: copy the new backup — especially `SECRETS/.env.secrets` → your `POLYMARKET_PRIVATE_KEY` — to a USB/offline drive; that one key is full control of the funds.**

### GitHub — blocked on remote/credentials (operator action)
This working copy is a **ZIP download, not a clone**: `git remote -v` is empty, there is only one "Initial commit", and the `gh` CLI is not installed. I cannot push without your repo URL + credentials. **Operator: provide the GitHub repo URL (and a token / `gh auth login`)**; then push with the steps in `SETUP_GUIDE.md`. The repo must keep `POLYPROPHET.env`/secrets OUT of git (`.gitignore` covers them). A full from-zero **friend setup guide** was written to `SETUP_GUIDE.md`.

### Honest timeline (PROJECTED, no-further-loss path; not a promise)
At **$38.55**, `fEff=0.85`, per-fill edge ~0.93-1.3% (blended with the ~30% cheaper fills), OBSERVED 15m-only fills ~**3-13/day (mean ~6-7)**: **+$100 profit ≈ ~3-4 weeks** (faster on hot/high-volatility days). **$100 in 7 days remains impossible** (needs ~45-60 fills/day; the gate supplies single digits). The clean accelerator remains **more bankroll**, not more risk.

### Premortem / traps
Likeliest 2-week damage: a *first-ever* 15m reversal (latent ~0.43%) on a large fill, or a loss cluster near the $5.50 floor — bounded by z≥3 / bps gates / ask≤0.97(deep) / Policy-B. The 1h `tLeft=600` mechanism stays gated out. No new trap. The one standing operator-action item is durable recorder autostart.

---

## 14. WHAT PREVIOUS INVESTIGATIONS FOUND (REFERENCE ONLY — RE-VERIFY)

These are findings from previous README passes. They are REFERENCE ONLY — re-investigate before accepting.

### Strategies tried and their outcomes
| Era | Strategy | Outcome | README | Status for re-investigation |
|---|---|---|---|---|
| v2-v5 | Various directional/scalp | Repeatedly failed live transfer | v2-v5 | Dismissed by prior AIs but RE-INVESTIGATE if new angle found |
| v9 | Lead-Lag momentum | Built and deployed | v9 | Superseded by SNIPE |
| v10 | Winner/Death-Bounce | Multiple bugs found and fixed | v10 | Bugs fixed, strategy superseded |
| v11 | Zero-Variance (arbitrage) | 0 executable opportunities found at $5 bankroll | v11 | RE-INVESTIGATE — conditions may have changed, prior AI may have missed something |
| v11 | CONVICTION/Epoch 3 | Disproven as deployable (incomplete ledger, crash-recovered) | v11 | RE-INVESTIGATE from raw data if relevant |
| v12 | Native SNIPE | Proven in backtest (1500+W/2L), deployed, went 176W/1L live | v12 | CURRENT STRATEGY — needs fix/improvement |
| v13 | Monte Carlo analysis | 10K-path MC showed bust risk at various loss rates | v13 | USEFUL REFERENCE but was on different config (cap 0.97-0.99) |
| v30 | Buy-every-cycle fillability | Winner asks vanish ~70% near close | v30 | RE-INVESTIGATE for earlier entry, different timing |
| v33 | Maker/limit entry | 3W/0L proxy fills (queue-uncertain) | v33 | PROMISING — needs more evidence |

### Venues investigated
| Venue | Prior finding | README | Re-investigate? |
|---|---|---|---|
| Polymarket SNIPE | Core edge is real, sizing/timeframe needs fixing | v12-v36 | YES — fix current strategy |
| Hyperliquid perps | 11W/29L momentum, 2W/24L fade — catastrophic. Shared signal doesn't transfer. | v13 | MAYBE — but needs completely different strategy, not shared signal |
| Cross-venue arb (Poly/Kalshi) | Needs >$5 per venue, legging risk | v11 | RE-INVESTIGATE if conditions changed |
| DeFi yield | Single-digit APY, won't hit goal | v11 | UNLIKELY but don't fully dismiss |
| Betfair Exchange | UK-based, allows algo trading | v36 | NOT YET INVESTIGATED |
| CEX spot/futures | Various | v36 | NOT YET INVESTIGATED |
