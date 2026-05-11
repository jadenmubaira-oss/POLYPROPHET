const fs = require('fs');
const path = require('path');
const { buildSlug, fetchMarketBySlug } = require('../lib/market-discovery');

function walk(d) {
    if (!fs.existsSync(d)) return [];
    return fs.readdirSync(d, {withFileTypes: true}).flatMap(e => {
        const p2 = path.join(d, e.name);
        return e.isDirectory() ? walk(p2) : (e.name.endsWith('.jsonl') ? [p2] : []);
    });
}

function normalizeOutcome(value) {
    const normalized = String(value || '').trim().toUpperCase();
    if (['YES', 'UP'].includes(normalized)) return 'YES';
    if (['NO', 'DOWN'].includes(normalized)) return 'NO';
    return null;
}

function parseOutcomePrices(value) {
    if (Array.isArray(value)) return value.map(Number);
    try { return JSON.parse(value || '[]').map(Number); } catch { return []; }
}

function gammaOutcome(market) {
    if (!market) return null;
    const resolved = market?.resolved === true || market?.closed === true;
    if (!resolved) return null;
    const prices = parseOutcomePrices(market.outcomePrices);
    if (prices.length >= 2) {
        if (Number.isFinite(prices[0]) && prices[0] >= 0.99) return 'YES';
        if (Number.isFinite(prices[1]) && prices[1] >= 0.99) return 'NO';
    }
    return normalizeOutcome(market.winningOutcome || market.winner || market.outcome);
}

async function main() {
    const files = walk('data/paper-shadow');
    const cycles = new Map();
    const settlements = new Map();
    const ticksByCycle = new Map();

    for (const f of files) {
        const text = fs.readFileSync(f, 'utf8').trim();
        if (!text) continue;
        const lines = text.split(/\r?\n/).filter(Boolean);
        for (const line of lines) {
            let r;
            try { r = JSON.parse(line); } catch { continue; }
            
            const cycleKey = `${r.asset}:${r.tf}:${r.epoch}`;
            
            if (r.__settlement__) {
                settlements.set(cycleKey, normalizeOutcome(r.outcome || r.resolution));
                continue;
            }
            
            if (!r.structural || !r.structural.ok || !r.asset || !r.tf || !r.epoch) continue;
            
            const epochKey = `${r.tf}:${r.epoch}`;
            if (!cycles.has(epochKey)) cycles.set(epochKey, {});
            if (!cycles.get(epochKey)[r.asset]) cycles.get(epochKey)[r.asset] = [];
            
            cycles.get(epochKey)[r.asset].push({
                ts: r.ts || (r.iso ? new Date(r.iso).getTime() : 0),
                dir: r.structural.direction,
                bps: r.structural.moveBps,
                bestAsk: r.bestAsk,
                noBestAsk: r.noBestAsk || r.noPrice
            });
            
            if (!ticksByCycle.has(cycleKey)) ticksByCycle.set(cycleKey, { asset: String(r.asset).toUpperCase(), tf: r.tf, epoch: Number(r.epoch) });
        }
    }

    const opportunities = [];

    for (const [epochKey, assets] of cycles.entries()) {
        const leadAssets = ['BTC', 'ETH'];
        const lagAssets = ['SOL', 'XRP', 'DOGE', 'BNB'];
        
        let leadMaxBps = 0;
        let leadDir = null;
        let leadAsset = null;
        let leadTs = null;
        
        // Chronological scan to prevent look-ahead bias
        let triggerFound = false;
        
        // Flatten all ticks for the cycle and sort chronologically
        let allTicks = [];
        for (const [asset, assetTicks] of Object.entries(assets)) {
            for (const t of assetTicks) {
                allTicks.push({ asset, ...t });
            }
        }
        allTicks.sort((a, b) => a.ts - b.ts);
        
        for (const tick of allTicks) {
            if (leadAssets.includes(tick.asset) && Math.abs(tick.bps) >= 15) {
                leadMaxBps = tick.bps;
                leadDir = tick.dir;
                leadAsset = tick.asset;
                leadTs = tick.ts;
                triggerFound = true;
                break; // Trigger on FIRST crossing of 15 bps
            }
        }
        
        if (!triggerFound) continue;
        
        for (const lag of lagAssets) {
            if (!assets[lag]) continue;
            
            const lagTick = assets[lag].find(t => t.ts >= leadTs && (t.ts - leadTs) < 30000);
            if (lagTick && Math.abs(lagTick.bps) < 5) {
                const cycleKey = `${lag}:${epochKey}`;
                opportunities.push({
                    cycleKey,
                    asset: lag,
                    tf: epochKey.split(':')[0],
                    epoch: Number(epochKey.split(':')[1]),
                    leadAsset,
                    leadBps: leadMaxBps,
                    leadDir,
                    lagBps: lagTick.bps,
                    lagAsk: leadDir === 'UP' ? lagTick.bestAsk : lagTick.noBestAsk,
                });
            }
        }
    }

    // Fetch missing settlements
    const nowSec = Math.floor(Date.now() / 1000);
    let attempted = 0;
    let resolved = 0;

    for (const opp of opportunities) {
        if (settlements.has(opp.cycleKey)) continue;
        if (nowSec < opp.epoch + 300 + 30) continue; // rough buffer
        
        attempted++;
        try {
            const market = await fetchMarketBySlug(buildSlug(opp.asset, opp.tf, opp.epoch));
            const outcome = gammaOutcome(market);
            if (outcome) {
                settlements.set(opp.cycleKey, outcome);
                resolved++;
            }
        } catch (e) {}
    }

    let wins = 0, losses = 0, pending = 0;
    const ADVERSE_FILL_CENTS = 0.05;
    const SLIPPAGE_PCT = 0.015;
    
    let bankroll = 10; // $10 start
    const stakeFraction = 0.25;

    for (const opp of opportunities) {
        const settlement = settlements.get(opp.cycleKey);
        opp.win = settlement ? (normalizeOutcome(settlement) === (opp.leadDir === 'UP' ? 'YES' : 'NO')) : null;
        
        if (opp.win === null) {
            pending++;
            continue;
        }

        const rawPrice = opp.lagAsk;
        if (!Number.isFinite(rawPrice) || rawPrice <= 0 || rawPrice >= 0.95) {
            // Price too high or invalid, skip
            continue;
        }

        const effectivePrice = Math.min(0.99, (rawPrice + ADVERSE_FILL_CENTS) * (1 + SLIPPAGE_PCT));
        
        // Fee calculation (Polymarket standard is complicated, but ~2-3% of size)
        // Let's use 3.25% to be conservative based on earlier audits
        const feeRate = 0.0325;
        
        const stake = Math.min(bankroll * stakeFraction, 50); // Max $50 stake
        if (stake < 0.10) { bankroll = 0; break; }
        
        const shares = stake / effectivePrice;
        
        if (opp.win === true) {
            wins++;
            const gross = shares * (1 - effectivePrice);
            const net = gross * (1 - feeRate);
            bankroll += net;
        } else {
            losses++;
            bankroll -= stake;
        }
    }

    console.log(JSON.stringify({
        opportunitiesFound: opportunities.length,
        settled: wins + losses,
        wins,
        losses,
        winRate: (wins + losses) > 0 ? (wins / (wins + losses)).toFixed(2) : 0,
        endBankroll: bankroll.toFixed(2),
        pending
    }, null, 2));
}

main().catch(console.error);