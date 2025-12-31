const fs = require('fs');
const path = require('path');

const DEBUG_FILES = [
  path.join('debug', 'polyprophet_debug_2025-12-29T21-31-12-522Z.json'),
  path.join('debug', 'polyprophet_debug_2025-12-29T22-43-23-099Z.json'),
];

function safeNumber(x) {
  return Number.isFinite(x) ? x : null;
}

function approxEffectiveMaxOdds({ uptimeSec, baseMaxOdds }) {
  if (safeNumber(uptimeSec) === null || safeNumber(baseMaxOdds) === null) return baseMaxOdds;

  // Mirrors current server behavior when no trades occurred:
  // - lastTradeTime is initialized on startup, so <1h after startup triggers "tighten by 2¢"
  // - after 2h it tries to expand, but if baseMaxOdds is already high it does nothing
  if (uptimeSec < 3600) return Math.max(baseMaxOdds - 0.02, 0.20);
  if (uptimeSec >= 7200) return Math.min(baseMaxOdds, 0.90);
  return baseMaxOdds;
}

function summarize(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));

  const uptimeSec = data.serverUptime;
  const cfg = data.config || {};
  const baseMaxOdds = cfg.ORACLE?.maxOdds;
  const effMaxOdds = approxEffectiveMaxOdds({ uptimeSec, baseMaxOdds });

  const summary = {
    file: path.basename(file),
    exportTime: data.exportTime,
    nodeVersion: data.nodeVersion,
    uptimeMin: safeNumber(uptimeSec) ? (uptimeSec / 60).toFixed(1) : null,
    tradeCount: data.tradeExecutor?.tradeHistory?.length ?? null,
    paperBalance: data.tradeExecutor?.paperBalance ?? null,
    cfg: {
      minConfidence: cfg.ORACLE?.minConfidence,
      minConsensus: cfg.ORACLE?.minConsensus,
      minEdge: cfg.ORACLE?.minEdge,
      maxOdds: baseMaxOdds,
      effectiveMaxOddsApprox: effMaxOdds,
      maxGlobalTradesPerCycle: cfg.RISK?.maxGlobalTradesPerCycle,
      noTradeDetection: cfg.RISK?.noTradeDetection,
      assetEnabled: Object.fromEntries(Object.entries(cfg.ASSET_CONTROLS || {}).map(([a, v]) => [a, !!v?.enabled])),
    },
    assets: {},
  };

  const ASSETS = Object.keys(data.assets || {});
  for (const asset of ASSETS) {
    const cycles = data.assets?.[asset]?.cycleHistory || [];

    const counts = {
      cycles: cycles.length,
      tier: { CONVICTION: 0, ADVISORY: 0, NONE: 0, UNKNOWN: 0 },
      confGe80: 0,
      confGe90: 0,
      bestHour: 0,
      timeFilterPass: 0,
      oddsExtreme: 0,
      oddsLeEffectiveMax: 0,
      edgeNeg: 0,
      edgeLt5: 0,
      genesisDisagree: 0,
      wouldPassApproxAll: 0,
      tinyOrWeirdConf: 0,
    };

    for (const c of cycles) {
      const tier = c.tier || 'UNKNOWN';
      if (counts.tier[tier] === undefined) counts.tier[tier] = 0;
      counts.tier[tier]++;

      const conf = safeNumber(c.confidence);
      if (conf === null) {
        counts.tinyOrWeirdConf++;
      } else {
        if (conf >= 0.8) counts.confGe80++;
        if (conf >= 0.9) counts.confGe90++;
        if (conf > 0 && conf < 1e-6) counts.tinyOrWeirdConf++;
      }

      const endTime = c.cycleEndTime ? new Date(c.cycleEndTime) : null;
      const hour = endTime && !Number.isNaN(endTime.getTime()) ? endTime.getUTCHours() : null;
      const isBestHour = hour !== null && hour >= 14 && hour <= 16;
      if (isBestHour) counts.bestHour++;

      const timeFilterPass = isBestHour || tier === 'CONVICTION';
      if (timeFilterPass) counts.timeFilterPass++;

      const signal = c.prediction;
      const yes = safeNumber(c.marketOdds?.yesPrice);
      const no = safeNumber(c.marketOdds?.noPrice);
      const odds = signal === 'UP' ? yes : (signal === 'DOWN' ? no : null);

      const isExtreme = odds !== null && (odds < 0.20 || odds > 0.95);
      if (isExtreme) counts.oddsExtreme++;

      if (odds !== null && safeNumber(effMaxOdds) !== null && odds <= effMaxOdds) counts.oddsLeEffectiveMax++;

      // Approximate edgePercent as currently coded (note: this is *not* correct EV)
      const POLYMARKET_FEE = 0.02;
      if (conf !== null && odds !== null && odds > 0) {
        const effectiveConfidence = conf * (1 - POLYMARKET_FEE);
        const edgePct = ((effectiveConfidence - odds) / odds) * 100;

        if (edgePct < 0) counts.edgeNeg++;
        if (edgePct < 5) counts.edgeLt5++;

        const genesis = c.modelVotes?.genesis;
        if (genesis && genesis !== signal) counts.genesisDisagree++;

        const meetsAdvisory = tier === 'CONVICTION' || (tier === 'ADVISORY' && conf >= 0.80);
        const oddsBandPass = isExtreme || tier === 'CONVICTION';
        const executeTradeGuards = conf >= (cfg.ORACLE?.minConfidence ?? 0.8) && odds <= (cfg.ORACLE?.maxOdds ?? 0.9);
        const hardBlocksPass = edgePct >= 5 && (!genesis || genesis === signal);

        const pass = !!meetsAdvisory && !!timeFilterPass && !!oddsBandPass && !!executeTradeGuards && !!hardBlocksPass;
        if (pass) counts.wouldPassApproxAll++;
      }
    }

    summary.assets[asset] = counts;
  }

  return summary;
}

for (const file of DEBUG_FILES) {
  const s = summarize(file);
  console.log(`\n=== ${s.file} ===`);
  console.log(`exportTime ${s.exportTime} | node ${s.nodeVersion} | uptime(min) ${s.uptimeMin}`);
  console.log(`tradeHistory ${s.tradeCount} | paperBalance ${s.paperBalance}`);
  console.log(`ORACLE minConf ${s.cfg.minConfidence} maxOdds ${s.cfg.maxOdds} effMaxOdds~ ${s.cfg.effectiveMaxOddsApprox}`);
  console.log(`RISK maxGlobalTradesPerCycle ${s.cfg.maxGlobalTradesPerCycle} noTradeDetection ${s.cfg.noTradeDetection}`);
  console.log('ASSET enabled', s.cfg.assetEnabled);
  for (const [asset, c] of Object.entries(s.assets)) {
    console.log(
      `- ${asset}: cycles=${c.cycles} tier=${JSON.stringify(c.tier)} ` +
      `conf>=0.8=${c.confGe80} conf>=0.9=${c.confGe90} timePass=${c.timeFilterPass} ` +
      `extremeOdds=${c.oddsExtreme} edgeNeg=${c.edgeNeg} edge<5=${c.edgeLt5} ` +
      `genesisDisagree=${c.genesisDisagree} wouldPassApproxAll=${c.wouldPassApproxAll} weirdConf=${c.tinyOrWeirdConf}`
    );
  }
}


