#!/usr/bin/env node
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
        const nextTier = [
            { hr: 17, min: 7, s: 'H17 m7 UP [70-95c]', tier: 'A', wr: 90, n: 50 },
            { hr: 18, min: 7, s: 'H18 m7 DOWN [65-98c]', tier: 'A', wr: 90, n: 58 },
            { hr: 18, min: 11, s: 'H18 m11 UP [65-98c]', tier: 'S', wr: 100, n: 33 },
            { hr: 19, min: 6, s: 'H19 m6 UP [65-98c]', tier: 'A', wr: 92, n: 60 },
            { hr: 19, min: 10, s: 'H19 m10 UP (new)', tier: 'A', wr: 92, n: 60 },
            { hr: 20, min: 7, s: 'H20 m7 DOWN [65-98c]', tier: 'S', wr: 95, n: 56 },
            { hr: 20, min: 11, s: 'H20 m11 UP [65-98c]', tier: 'S', wr: 98, n: 43 },
            { hr: 21, min: 10, s: 'H21 m10 UP [65-98c]', tier: 'A', wr: 93, n: 67 },
            { hr: 22, min: 11, s: 'H22 m11 UP [65-98c]', tier: 'S', wr: 100, n: 34 }
        ];
        for (const n of nextTier) {
            const minsAway = (n.hr * 60 + n.min) - nowMinOfDay;
            if (minsAway > 0 && minsAway < 360) {
                const tStr = `${String(n.hr).padStart(2, '0')}:${String(n.min).padStart(2, '0')}`;
                const marker = n.tier === 'S' ? ' ⭐ TIER-S' : '';
                console.log(`  ${tStr} UTC | ${n.s.padEnd(26)} | ${n.wr}% OOS (${n.n}t) | ${String(minsAway).padStart(3)}min away${marker}`);
            }
        }
        console.log('');
        console.log('=== DEPOSIT TIMING RECOMMENDATION ===');
        const firstSWindow = nextTier.find(n => n.tier === 'S' && ((n.hr * 60 + n.min) - nowMinOfDay) > 20);
        if (firstSWindow) {
            const firstSMins = (firstSWindow.hr * 60 + firstSWindow.min) - nowMinOfDay;
            const depositBy = firstSMins - 25;
            const depositTime = new Date(now.getTime() + depositBy * 60000);
            console.log(`Next Tier-S: ${String(firstSWindow.hr).padStart(2, '0')}:${String(firstSWindow.min).padStart(2, '0')} UTC (${firstSMins} min away)`);
            console.log(`Deposit by: ${depositTime.toISOString().slice(11, 19)} UTC (give runtime 25 min to rebase)`);
            console.log(`Target signal: ${firstSWindow.s} @ ${firstSWindow.wr}% OOS WR on ${firstSWindow.n} trades`);
        } else {
            console.log('No Tier-S in next 6 hours');
        }
    });
}).on('error', e => console.error('ERR:', e.message));
