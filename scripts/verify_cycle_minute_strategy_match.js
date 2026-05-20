#!/usr/bin/env node
'use strict';

const path = require('path');
const { loadStrategySet, evaluateMatch } = require('../lib/strategy-matcher');

const TIMEFRAME = { key: '15m-cycle-minute-test', seconds: 900 };
const STRATEGY_REL = path.join('strategies', 'strategy_set_15m_crossval_7signal_v2.json');

function epochUtc(year, month, day, hour, minute, second = 0) {
    return Math.floor(Date.UTC(year, month - 1, day, hour, minute, second) / 1000);
}

function matchNamesAt(hour, cycleMinute, elapsedMinute, direction = 'UP') {
    const nowSec = epochUtc(2026, 5, 20, hour, cycleMinute, elapsedMinute * 60 + 5);
    const market = {
        asset: 'BTC',
        timeframe: '15m',
        yesPrice: 0.50,
        noPrice: 0.50,
        slug: `test-btc-${hour}-${cycleMinute}`,
        conditionId: `0xtest${hour}${cycleMinute}`
    };
    return evaluateMatch(market, nowSec, TIMEFRAME, {})
        .filter((match) => match.direction === direction)
        .map((match) => match.name);
}

function expectExactly(label, actual, expected) {
    const a = [...actual].sort();
    const e = [...expected].sort();
    const ok = a.length === e.length && a.every((value, index) => value === e[index]);
    return ok ? null : `${label}: expected [${e.join(', ')}], got [${a.join(', ')}]`;
}

function main() {
    const loaded = loadStrategySet(TIMEFRAME.key, STRATEGY_REL);
    const failures = [];
    if (loaded !== 7) failures.push(`loaded strategy count expected 7, got ${loaded}`);

    failures.push(
        expectExactly('H19 should not fire at 19:00 cycle', matchNamesAt(19, 0, 0), []),
        expectExactly('H19 should not fire at 19:15 cycle', matchNamesAt(19, 15, 0), []),
        expectExactly('H19 should fire only at 19:30 cycle minute 0', matchNamesAt(19, 30, 0), ['CROSSVAL_15M_H19_M30_UP']),
        expectExactly('H19 should not fire at 19:45 cycle', matchNamesAt(19, 45, 0), []),
        expectExactly('H19 should not fire at elapsed minute 1', matchNamesAt(19, 30, 1), []),
        expectExactly('H12:15 should fire at cycle minute 15 elapsed minute 1', matchNamesAt(12, 15, 1), ['CROSSVAL_15M_H12_M15_UP']),
        expectExactly('H12:30 should fire at cycle minute 30 elapsed minute 2', matchNamesAt(12, 30, 2), ['CROSSVAL_15M_H12_M30_UP']),
        expectExactly('H12 should not cross-fire at 12:45', matchNamesAt(12, 45, 1), [])
    );

    const compactFailures = failures.filter(Boolean);
    const report = {
        generatedAt: new Date().toISOString(),
        strategyFile: STRATEGY_REL,
        loadedStrategies: loaded,
        verdict: compactFailures.length ? 'FAIL_CYCLE_MINUTE_PARITY' : 'PASS_CYCLE_MINUTE_PARITY',
        failures: compactFailures
    };

    console.log(JSON.stringify(report, null, 2));
    process.exitCode = compactFailures.length ? 1 : 0;
}

main();