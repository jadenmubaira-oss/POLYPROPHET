/**
 * OMEGA V2: MASTER BACKTEST HARNESS
 * 
 * Replays logs through the Pinnacle Orchestrator.
 */

const fs = require('fs');
const SupremeBrain = require('./src/supreme_brain');
const { OmegaBridge } = require('./src/bridge');

// Mock Config
const CONFIG = {
    STARTING_BALANCE: 5.00,
    ORACLE: { minConfidence: 0.90, maxOdds: 0.70 }
};

async function runBacktest(logPath) {
    console.log(`[OMEGA-BT] 🏁 Starting Master Backtest: ${logPath}`);

    // Initialize Engines
    const brains = { BTC: new SupremeBrain('BTC', CONFIG) };
    const bridge = new OmegaBridge(brains, CONFIG);

    let bankroll = CONFIG.STARTING_BALANCE;
    let trades = 0;

    // Load Data
    const data = JSON.parse(fs.readFileSync(logPath, 'utf8'));

    // Simulation Loop
    for (const entry of data.cycles || []) {
        const verdict = bridge.evaluate('BTC', entry.market);

        if (verdict && verdict.isStrike) {
            const result = simulateTrade(verdict, entry.outcome);
            bankroll += result.pnl;
            trades++;
            console.log(`[OMEGA-BT] 📉 Trade ${trades}: ${verdict.asset} ${verdict.prediction} | P&L: $${result.pnl.toFixed(2)} | Balance: $${bankroll.toFixed(2)}`);
        }
    }

    console.log(`
    [OMEGA-BT] ✅ Backtest Complete
    💰 Final Balance: $${bankroll.toFixed(2)}
    📊 Total Trades: ${trades}
    🚀 Multiplier: ${(bankroll / CONFIG.STARTING_BALANCE).toFixed(1)}x
    `);
}

function simulateTrade(verdict, outcome) {
    const win = verdict.prediction === outcome;
    const pnl = win ? verdict.allowedSize * (1 / 0.7 - 1) : -verdict.allowedSize;
    return { pnl };
}

// runBacktest('./debug/last_cycle.json');
module.exports = { runBacktest };
