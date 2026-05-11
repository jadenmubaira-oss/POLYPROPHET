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
    const files = walk('data/paper-shadow').filter(f => f.includes('5m'));
    const cycles = new Map();
    const settlements = new Map();

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
            
            if (!r.structural || !r.structural.ok || !r.asset || r.tf !== '5m' || !r.epoch) continue;
            
            if (!cycles.has(cycleKey)) cycles.set(cycleKey, { asset: r.asset, tf: r.tf, epoch: Number(r.epoch), ticks: [] });
            
            cycles.get(cycleKey).ticks.push({
                ts: r.ts || (r.iso ? new Date(r.iso).getTime() : 0),
                dir: r.structural.direction,
                bps: r.structural.absMoveBps || Math.abs(r.structural.moveBps),
                bestAsk: r.bestAsk,
                noBestAsk: r.noBestAsk || r.noPrice,
                secondsUntilClose: r.secondsUntilClose,
                secondsIntoEpoch: r.secondsIntoEpoch || (r.ts ? r.ts - r.epoch : 0)
            });
        }
    }

    const thresholds = [10, 15, 20, 25];
    const results = {};

    for (const threshold of thresholds) {
        results[threshold] = {};
        for (const [cycleKey, cycle] of cycles.entries()) {
            cycle.ticks.sort((a, b) => a.ts - b.ts);
            
            // We want to trigger between XX:03:00 and XX:04:14 (i.e. secondsIntoEpoch between 180 and 254)
            // But we specifically want the closed candle. The structual signal might use latestPrice though.
            // For this test, we just look for ANY tick where bps >= threshold AND secondsIntoEpoch is in safe window (<= 254)
            
            const triggerTick = cycle.ticks.find(t => t.bps >= threshold && t.secondsIntoEpoch >= 180 && t.secondsIntoEpoch <= 254);
            if (!triggerTick) continue;

            const ask = triggerTick.dir === 'UP' ? triggerTick.bestAsk : triggerTick.noBestAsk;
            
            const askLimits = [0.70, 0.75, 0.80, 0.85, 0.90, 0.95];
            
            for (const limit of askLimits) {
                if (!results[threshold][limit]) results[threshold][limit] = { opportunities: [] };
                if (ask <= limit) {
                    results[threshold][limit].opportunities.push({
                        cycleKey,
                        asset: cycle.asset,
                        tf: cycle.tf,
                        epoch: cycle.epoch,
                        bps: triggerTick.bps,
                        dir: triggerTick.dir,
                        ask: ask
                    });
                }
            }
        }
    }

    // Fetch missing settlements
    const opps10 = results[10][0.95]?.opportunities || [];
    const nowSec = Math.floor(Date.now() / 1000);
    
    for (const opp of opps10) {
        if (settlements.has(opp.cycleKey)) continue;
        if (nowSec < opp.epoch + 300 + 30) continue;
        
        try {
            const market = await fetchMarketBySlug(buildSlug(opp.asset, opp.tf, opp.epoch));
            const outcome = gammaOutcome(market);
            if (outcome) settlements.set(opp.cycleKey, outcome);
        } catch (e) {}
    }

    // Evaluate
    for (const threshold of thresholds) {
        for (const limit of [0.70, 0.75, 0.80, 0.85, 0.90, 0.95]) {
            if (!results[threshold][limit]) continue;
            
            let wins = 0, losses = 0, pending = 0;
            let bankroll = 10;
            let tradesExecuted = 0;
            let maxBankroll = 10;
            let maxDrawdown = 0;
            
            for (const opp of results[threshold][limit].opportunities) {
                const settlement = settlements.get(opp.cycleKey);
                opp.win = settlement ? (normalizeOutcome(settlement) === (opp.dir === 'UP' ? 'YES' : 'NO')) : null;
                
                if (opp.win === null) {
                    pending++;
                    continue;
                }

                const rawPrice = opp.ask;
                if (!Number.isFinite(rawPrice) || rawPrice <= 0 || rawPrice >= 0.95) continue;

                const effectivePrice = Math.min(0.99, (rawPrice + 0.05) * 1.015);
                const stake = Math.min(bankroll * 0.40, 50); // 40% Kelly-like stake
                if (stake < 0.10) { bankroll = 0; break; }
                
                const shares = stake / effectivePrice;
                tradesExecuted++;
                
                if (opp.win === true) {
                    wins++;
                    const gross = shares * (1 - effectivePrice);
                    const net = gross * (1 - 0.0325);
                    bankroll += net;
                } else {
                    losses++;
                    bankroll -= stake;
                }
                
                if (bankroll > maxBankroll) maxBankroll = bankroll;
                const dd = (maxBankroll - bankroll) / maxBankroll;
                if (dd > maxDrawdown) maxDrawdown = dd;
            }
            
            if (tradesExecuted > 0) {
                const wr = (wins/(wins+losses)||0).toFixed(2);
                console.log(`5m | Thr ${threshold}bps | Ask<=${limit} | Opps: ${results[threshold][limit].opportunities.length} | Exec: ${tradesExecuted} | W: ${wins} L: ${losses} | WR: ${wr} | End: $${bankroll.toFixed(2)}`);
            }
        }
    }
}

main().catch(console.error);