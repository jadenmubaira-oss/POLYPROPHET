#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const https = require('https');

const now = new Date();
console.log('=== CURRENT TIME ===');
console.log('UTC:', now.toISOString());
console.log('Unix:', Math.floor(now.getTime() / 1000));
console.log('');

https.get('https://polyprophet-1-rr1g.onrender.com/api/health', (res) => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => {
        const j = JSON.parse(d);
        const strategyFilePath = j.strategySets?.['15m']?.filePath || '';
        const strategyBaseName = path.basename(strategyFilePath || '');
        const localStrategyPath = strategyBaseName ? path.join(process.cwd(), 'strategies', strategyBaseName) : null;
        let strategyRows = [];
        if (localStrategyPath && fs.existsSync(localStrategyPath)) {
            try {
                const parsed = JSON.parse(fs.readFileSync(localStrategyPath, 'utf8'));
                strategyRows = Array.isArray(parsed?.strategies) ? parsed.strategies : [];
            } catch (e) {
                strategyRows = [];
            }
        }
        console.log('=== LIVE HEALTH ===');
        console.log('Deploy:', j.deployVersion.slice(0, 8));
        console.log('Started:', j.startedAt);
        console.log('Uptime:', (j.uptime / 60).toFixed(1), 'min');
        console.log('Mode:', j.mode, '| isLive:', j.isLive);
        console.log('Balance:', j.balance, 'USDC');
        console.log('');
        console.log('=== STRATEGY STATUS ===');
        console.log('File:', j.strategySets?.['15m']?.filePath);
        console.log('Count:', j.strategySets?.['15m']?.strategies);
        console.log('LoadError:', j.strategySets?.['15m']?.loadError || 'none');
        console.log('');
        console.log('=== GATES ===');
        console.log('Pending settlements:', j.orchestrator?.pendingSettlements);
        console.log('Active markets:', j.orchestrator?.activeMarkets, '/', j.orchestrator?.totalMarkets);
        console.log('Error halt:', j.errorHalt?.halted);
        console.log('Trade failure halt:', j.tradeFailureHalt?.halted);
        console.log('Start paused env:', j.runtimeState?.startPausedEnv);
        console.log('Redis connected:', j.runtimeState?.redisConnected);
        console.log('');
        console.log('=== NEXT TIER-A/S SIGNAL WINDOWS ===');
        const utcMin = now.getUTCMinutes();
        const utcHr = now.getUTCHours();
        const nowMinOfDay = utcHr * 60 + utcMin;
        const nextTier = strategyRows
            .filter(s => Number.isFinite(Number(s.utcHour)) && Number.isFinite(Number(s.entryMinute)))
            .map(s => {
                const hr = Number(s.utcHour);
                const min = Number(s.entryMinute);
                let minsAway = (hr * 60 + min) - nowMinOfDay;
                if (minsAway <= 0) minsAway += 24 * 60;
                return {
                    hr,
                    min,
                    minsAway,
                    s: `${s.name} ${String(s.direction || '').toUpperCase()} [${Math.round(Number(s.priceMin || 0) * 100)}-${Math.round(Number(s.priceMax || 0) * 100)}c]`,
                    tier: String(s.tier || 'A').toUpperCase(),
                    wr: Math.round(Number(s.pWinEstimate || s.winRate || 0) * 1000) / 10,
                    lcb: Math.round(Number(s.winRateLCB || 0) * 1000) / 10,
                    n: Number(s?.stats?.oos?.trades || 0)
                };
            })
            .sort((a, b) => a.minsAway - b.minsAway || b.lcb - a.lcb);
        for (const n of nextTier) {
            const minsAway = (n.hr * 60 + n.min) - nowMinOfDay;
            const normalizedAway = minsAway > 0 ? minsAway : minsAway + 24 * 60;
            if (normalizedAway > 0 && normalizedAway < 360) {
                const tStr = `${String(n.hr).padStart(2, '0')}:${String(n.min).padStart(2, '0')}`;
                const marker = n.tier === 'S' ? ' ⭐ TIER-S' : '';
                console.log(`  ${tStr} UTC | ${n.s.padEnd(34)} | ${n.wr}% OOS / ${n.lcb}% LCB (${n.n}t) | ${String(normalizedAway).padStart(3)}min away${marker}`);
            }
        }
        console.log('');
        console.log('=== DEPOSIT TIMING RECOMMENDATION ===');
        const firstSWindow = nextTier.find(n => n.tier === 'S' && n.minsAway > 20);
        if (firstSWindow) {
            const firstSMins = firstSWindow.minsAway;
            const depositBy = firstSMins - 25;
            const depositTime = new Date(now.getTime() + depositBy * 60000);
            console.log(`Next Tier-S: ${String(firstSWindow.hr).padStart(2, '0')}:${String(firstSWindow.min).padStart(2, '0')} UTC (${firstSMins} min away)`);
            console.log(`Deposit by: ${depositTime.toISOString().slice(11, 19)} UTC (give runtime 25 min to rebase)`);
            console.log(`Target signal: ${firstSWindow.s} @ ${firstSWindow.wr}% OOS WR / ${firstSWindow.lcb}% LCB on ${firstSWindow.n} trades`);
        } else if (nextTier.length > 0) {
            const firstWindow = nextTier.find(n => n.minsAway > 20) || nextTier[0];
            const depositBy = Math.max(0, firstWindow.minsAway - 25);
            const depositTime = new Date(now.getTime() + depositBy * 60000);
            console.log(`No Tier-S in next 6 hours. Earliest strong window: ${String(firstWindow.hr).padStart(2, '0')}:${String(firstWindow.min).padStart(2, '0')} UTC`);
            console.log(`Deposit by: ${depositTime.toISOString().slice(11, 19)} UTC (give runtime 25 min to rebase)`);
            console.log(`Target signal: ${firstWindow.s} @ ${firstWindow.wr}% OOS WR / ${firstWindow.lcb}% LCB on ${firstWindow.n} trades`);
        } else {
            console.log('Unable to derive windows from the current live 15m strategy artifact');
        }
    });
}).on('error', e => console.error('ERR:', e.message));
