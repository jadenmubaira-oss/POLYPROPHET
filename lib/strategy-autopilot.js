const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function parseBool(value, fallback = false) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function parseNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeReadJson(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function utcStamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function compactDateStamp(date = new Date()) {
  return date.toISOString().slice(0, 19).replace(/[-:T]/g, '');
}

function round(value, digits = 4) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 10 ** digits) / 10 ** digits : null;
}

function cyclesFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.cycles)) return payload.cycles;
  return [];
}

function mergeCycles(localPayload, freshPayload) {
  const localCycles = cyclesFromPayload(localPayload);
  const freshCycles = cyclesFromPayload(freshPayload);
  const map = new Map();
  for (const cycle of [...localCycles, ...freshCycles]) {
    const asset = String(cycle?.asset || '').toUpperCase();
    const epoch = Number(cycle?.epoch);
    if (!asset || !Number.isFinite(epoch)) continue;
    map.set(`${asset}_${epoch}`, { ...cycle, asset, epoch });
  }
  const cycles = [...map.values()].sort((a, b) => a.epoch - b.epoch || String(a.asset).localeCompare(String(b.asset)));
  return {
    ...(localPayload && typeof localPayload === 'object' && !Array.isArray(localPayload) ? localPayload : {}),
    generatedAt: new Date().toISOString(),
    source: 'strategy_autopilot_merge',
    cycles,
    autopilotMerge: {
      localCycles: localCycles.length,
      freshCycles: freshCycles.length,
      mergedCycles: cycles.length,
    },
  };
}

class StrategyAutopilot {
  constructor(options = {}) {
    this.root = options.root || path.join(__dirname, '..');
    this.telegram = options.telegram || null;
    this.getRuntimeContext = typeof options.getRuntimeContext === 'function' ? options.getRuntimeContext : () => ({});
    this.onStateChange = typeof options.onStateChange === 'function' ? options.onStateChange : null;
    this.appendDiagnostic = typeof options.appendDiagnostic === 'function' ? options.appendDiagnostic : null;
    this.statePath = options.statePath || path.join(this.root, 'data', 'strategy-autopilot-candidates.json');
    this.enabled = parseBool(process.env.STRATEGY_AUTOPILOT_ENABLED, true);
    this.autoDeployEnabled = false;
    this.intervalHours = Math.max(1, parseNumber(process.env.STRATEGY_AUTOPILOT_INTERVAL_HOURS, 24));
    this.utcHour = Math.max(0, Math.min(23, parseNumber(process.env.STRATEGY_AUTOPILOT_UTC_HOUR, 5)));
    this.utcMinute = Math.max(0, Math.min(59, parseNumber(process.env.STRATEGY_AUTOPILOT_UTC_MINUTE, 20)));
    this.checkIntervalMs = Math.max(60_000, parseNumber(process.env.STRATEGY_AUTOPILOT_CHECK_MS, 10 * 60 * 1000));
    this.minRunGapMs = Math.max(60 * 60 * 1000, parseNumber(process.env.STRATEGY_AUTOPILOT_MIN_GAP_MS, this.intervalHours * 60 * 60 * 1000));
    this.timeoutMs = Math.max(5 * 60 * 1000, parseNumber(process.env.STRATEGY_AUTOPILOT_TIMEOUT_MS, 55 * 60 * 1000));
    this.fetchDays = Math.max(1, parseNumber(process.env.STRATEGY_AUTOPILOT_FETCH_DAYS, 4));
    this.holdoutDays = Math.max(1, parseNumber(process.env.STRATEGY_AUTOPILOT_HOLDOUT_DAYS, 3));
    this.maxStrategies = Math.max(1, parseNumber(process.env.STRATEGY_AUTOPILOT_MAX_STRATEGIES, 6));
    this.minReviewPWin = Math.max(0, Math.min(1, parseNumber(process.env.STRATEGY_AUTOPILOT_MIN_REVIEW_PWIN, 0.64)));
    this.minReviewWr = Math.max(0, Math.min(1, parseNumber(process.env.STRATEGY_AUTOPILOT_MIN_REVIEW_WR, 0.78)));
    this.maxReviewBustRate = Math.max(0, Math.min(1, parseNumber(process.env.STRATEGY_AUTOPILOT_MAX_REVIEW_BUST_RATE, 0.01)));
    this.updateCycleData = parseBool(process.env.STRATEGY_AUTOPILOT_UPDATE_CYCLE_DATA, true);
    this.notifyOnEveryRun = parseBool(process.env.STRATEGY_AUTOPILOT_NOTIFY_EVERY_RUN, true);
    this.running = false;
    this.timer = null;
    this.state = this.loadState();
  }

  loadState() {
    const fallback = {
      version: 1,
      enabled: this.enabled,
      autoDeployEnabled: false,
      lastRunAt: null,
      lastCompletedAt: null,
      lastError: null,
      lastCandidateId: null,
      candidates: [],
      decisions: [],
      declineLog: [],
    };
    const parsed = safeReadJson(this.statePath, fallback) || fallback;
    parsed.version = 1;
    parsed.candidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
    parsed.decisions = Array.isArray(parsed.decisions) ? parsed.decisions : [];
    parsed.declineLog = Array.isArray(parsed.declineLog) ? parsed.declineLog : [];
    parsed.enabled = this.enabled;
    parsed.autoDeployEnabled = false;
    return parsed;
  }

  importState(state = {}) {
    if (!state || typeof state !== 'object') return;
    if (Array.isArray(state.candidates)) this.state.candidates = state.candidates;
    if (Array.isArray(state.decisions)) this.state.decisions = state.decisions;
    if (Array.isArray(state.declineLog)) this.state.declineLog = state.declineLog;
    if (typeof state.lastRunAt === 'string') this.state.lastRunAt = state.lastRunAt;
    if (typeof state.lastCompletedAt === 'string') this.state.lastCompletedAt = state.lastCompletedAt;
    if (typeof state.lastError === 'string' || state.lastError === null) this.state.lastError = state.lastError;
    if (typeof state.lastCandidateId === 'string' || state.lastCandidateId === null) this.state.lastCandidateId = state.lastCandidateId;
    this.state.enabled = this.enabled;
    this.state.autoDeployEnabled = false;
  }

  exportState() {
    return {
      version: 1,
      enabled: this.enabled,
      autoDeployEnabled: false,
      lastRunAt: this.state.lastRunAt || null,
      lastCompletedAt: this.state.lastCompletedAt || null,
      lastError: this.state.lastError || null,
      lastCandidateId: this.state.lastCandidateId || null,
      candidates: this.state.candidates.slice(-25),
      decisions: this.state.decisions.slice(-100),
      declineLog: this.state.declineLog.slice(-100),
    };
  }

  persist() {
    this.state.enabled = this.enabled;
    this.state.autoDeployEnabled = false;
    this.state.candidates = this.state.candidates.slice(-25);
    this.state.decisions = this.state.decisions.slice(-100);
    this.state.declineLog = this.state.declineLog.slice(-100);
    writeJson(this.statePath, this.state);
    if (this.onStateChange) Promise.resolve(this.onStateChange()).catch(() => null);
  }

  diagnostic(type, payload = {}) {
    if (this.appendDiagnostic) {
      this.appendDiagnostic({ ts: new Date().toISOString(), type, ...payload });
    }
  }

  start() {
    if (this.timer || !this.enabled) return;
    this.timer = setInterval(() => {
      this.maybeRun('SCHEDULE').catch((error) => this.recordError(error, 'SCHEDULE'));
    }, this.checkIntervalMs);
    this.timer.unref?.();
    setTimeout(() => {
      this.maybeRun('BOOT_CHECK').catch((error) => this.recordError(error, 'BOOT_CHECK'));
    }, 30_000).unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  shouldRunNow() {
    if (!this.enabled || this.running) return { ok: false, reason: this.running ? 'RUNNING' : 'DISABLED' };
    const now = Date.now();
    const last = this.state.lastCompletedAt ? new Date(this.state.lastCompletedAt).getTime() : 0;
    if (last && now - last < this.minRunGapMs) return { ok: false, reason: 'MIN_GAP', nextEligibleAt: new Date(last + this.minRunGapMs).toISOString() };
    const d = new Date();
    const afterTarget = d.getUTCHours() > this.utcHour || (d.getUTCHours() === this.utcHour && d.getUTCMinutes() >= this.utcMinute);
    if (!afterTarget && last) return { ok: false, reason: 'BEFORE_DAILY_WINDOW' };
    return { ok: true };
  }

  async maybeRun(trigger = 'SCHEDULE') {
    const decision = this.shouldRunNow();
    if (!decision.ok) return { skipped: true, ...decision };
    return this.run(trigger);
  }

  async run(trigger = 'MANUAL') {
    if (!this.enabled) return { success: false, skipped: true, reason: 'DISABLED' };
    if (this.running) return { success: false, skipped: true, reason: 'RUNNING' };
    this.running = true;
    const startedAt = new Date();
    this.state.lastRunAt = startedAt.toISOString();
    this.state.lastError = null;
    this.persist();
    this.diagnostic('STRATEGY_AUTOPILOT_STARTED', { trigger });
    try {
      const result = await this.runPipeline(trigger, startedAt);
      this.state.lastCompletedAt = new Date().toISOString();
      this.state.lastCandidateId = result.candidate?.id || this.state.lastCandidateId || null;
      this.persist();
      this.notifyCandidate(result.candidate, result.summaryLines, result.recommendation).catch(() => null);
      this.diagnostic('STRATEGY_AUTOPILOT_COMPLETED', { trigger, candidateId: result.candidate?.id || null, recommendation: result.recommendation?.verdict || null });
      return { success: true, ...result };
    } catch (error) {
      this.recordError(error, trigger);
      throw error;
    } finally {
      this.running = false;
    }
  }

  recordError(error, trigger) {
    this.state.lastError = error?.message || String(error);
    this.persist();
    this.diagnostic('STRATEGY_AUTOPILOT_ERROR', { trigger, error: this.state.lastError });
    if (this.telegram?.notifyError) this.telegram.notifyError('strategy-autopilot', error);
  }

  runCommand(command, args, options = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: this.root,
        env: { ...process.env, ...(options.env || {}) },
        shell: false,
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      const maxBuffer = 2_000_000;
      child.stdout.on('data', (chunk) => { stdout = (stdout + chunk.toString()).slice(-maxBuffer); });
      child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-maxBuffer); });
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`COMMAND_TIMEOUT ${command} ${args.join(' ')}`));
      }, options.timeoutMs || this.timeoutMs);
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
  }

  async runPipeline(trigger, startedAt) {
    const outPrefix = `autopilot_${compactDateStamp(startedAt)}`;
    const searchEnv = {
      OUT_PREFIX: outPrefix,
      FORCE_FETCH: '1',
      FETCH_DAYS: String(this.fetchDays),
      HOLDOUT_DAYS: String(this.holdoutDays),
      MAX_STRATEGIES: String(this.maxStrategies),
      START_BALANCE: String(this.getRuntimeContext()?.bankroll || process.env.START_BALANCE || 10.43),
      HARD_ENTRY_PRICE_CAP: process.env.HARD_ENTRY_PRICE_CAP || '0.82',
      DEFAULT_MIN_ORDER_SHARES: process.env.DEFAULT_MIN_ORDER_SHARES || '5',
    };
    const search = await this.runCommand(process.execPath, ['scripts/fresh-strategy-search.js'], { env: searchEnv });
    const reportPath = path.join(this.root, 'debug', `fresh_strategy_search_${outPrefix}.json`);
    const strategyPath = path.join(this.root, 'strategies', `strategy_set_15m_fresh_best_${outPrefix}.json`);
    const freshPath = path.join(this.root, 'debug', `fresh_full_intracycle_${outPrefix}.json`);
    const report = safeReadJson(reportPath, null);
    const strategy = safeReadJson(strategyPath, null);
    if (!report || !strategy) {
      throw new Error(`AUTOPILOT_ARTIFACT_MISSING report=${fs.existsSync(reportPath)} strategy=${fs.existsSync(strategyPath)} code=${search.code}`);
    }
    let cycleUpdate = null;
    if (this.updateCycleData && fs.existsSync(freshPath)) {
      cycleUpdate = this.updateCycles(freshPath, outPrefix);
    }
    const validationPath = path.join(this.root, 'debug', `fresh_strategy_validation_${outPrefix}.json`);
    const validation = await this.runValidation(strategyPath, freshPath, validationPath);
    const recommendation = this.evaluateCandidate(strategy, report, validation.report);
    const candidate = this.storeCandidate({ outPrefix, trigger, reportPath, strategyPath, freshPath, validationPath, report, strategy, validation: validation.report, search, validationRun: validation.run, cycleUpdate, recommendation });
    return {
      candidate,
      recommendation,
      summaryLines: this.buildSummaryLines(candidate),
    };
  }

  updateCycles(freshPath, outPrefix) {
    const dataPath = path.join(this.root, 'data', 'intracycle-price-data.json');
    const local = safeReadJson(dataPath, { cycles: [] });
    const fresh = safeReadJson(freshPath, { cycles: [] });
    const merged = mergeCycles(local, fresh);
    const beforeCount = cyclesFromPayload(local).length;
    const afterCount = cyclesFromPayload(merged).length;
    const backupPath = path.join(this.root, 'data', `intracycle-price-data.autopilot-backup-${outPrefix}.json`);
    if (fs.existsSync(dataPath)) fs.copyFileSync(dataPath, backupPath);
    writeJson(dataPath, merged);
    return {
      dataPath: path.relative(this.root, dataPath),
      backupPath: path.relative(this.root, backupPath),
      beforeCount,
      freshCount: cyclesFromPayload(fresh).length,
      afterCount,
      added: afterCount - beforeCount,
    };
  }

  async runValidation(strategyPath, freshPath, validationPath) {
    const env = {
      STRATEGY_PATH: path.relative(this.root, strategyPath),
      FRESH_PATH: path.relative(this.root, freshPath),
      OUT_PATH: path.relative(this.root, validationPath),
      START_BALANCE: String(this.getRuntimeContext()?.bankroll || process.env.START_BALANCE || 10.43),
      HARD_ENTRY_PRICE_CAP: process.env.HARD_ENTRY_PRICE_CAP || '0.82',
      DEFAULT_MIN_ORDER_SHARES: process.env.DEFAULT_MIN_ORDER_SHARES || '5',
    };
    const run = await this.runCommand(process.execPath, ['scripts/validate-fresh-strategy.js'], { env });
    const report = safeReadJson(validationPath, null);
    if (!report) throw new Error(`AUTOPILOT_VALIDATION_MISSING code=${run.code}`);
    return { run, report };
  }

  evaluateCandidate(strategy, searchReport, validationReport) {
    const strategies = Array.isArray(strategy?.strategies) ? strategy.strategies : [];
    const minPWin = strategies.length ? Math.min(...strategies.map((s) => Number(s.pWinEstimate || 0)).filter(Number.isFinite)) : 0;
    const p64Compliant = strategies.length > 0 && minPWin >= this.minReviewPWin;
    const onePerCycle7d = validationReport?.windows?.['7d']?.selectedOnePerCycle || {};
    const sim7d = validationReport?.windows?.['7d']?.sim || {};
    const boot7d = validationReport?.bootstrapFreshHoldoutDays?.d7 || {};
    const wr7d = Number(onePerCycle7d.wr ?? sim7d.winRate ?? 0);
    const bust7d = Number(boot7d.bustRate ?? (sim7d.busted ? 1 : 0));
    const maxDd7d = Number(sim7d.maxDrawdown ?? 0);
    const final7d = Number(sim7d.finalBalance ?? 0);
    const issues = [];
    if (!strategies.length) issues.push('NO_STRATEGIES');
    if (!p64Compliant) issues.push(`MIN_PWIN_BELOW_${this.minReviewPWin}`);
    if (!(wr7d >= this.minReviewWr)) issues.push(`WR7D_BELOW_${this.minReviewWr}`);
    if (!(bust7d <= this.maxReviewBustRate)) issues.push(`BUST7D_ABOVE_${this.maxReviewBustRate}`);
    if (!(final7d > 0)) issues.push('NO_POSITIVE_7D_FINAL');
    if (maxDd7d > 0.65) issues.push('MAX_DRAWDOWN_HIGH');
    const verdict = issues.length ? 'STORE_ONLY' : 'REVIEW_CANDIDATE';
    return {
      verdict,
      beatsCurrent: verdict === 'REVIEW_CANDIDATE',
      safeForAutoDeploy: false,
      manualPromotionRequired: true,
      issues,
      metrics: {
        strategyCount: strategies.length,
        minPWin: round(minPWin),
        wr7d: round(wr7d),
        bust7d: round(bust7d),
        maxDd7d: round(maxDd7d),
        final7d: round(final7d, 2),
        mergedCycles: searchReport?.data?.mergedCycles || validationReport?.data?.mergedCycles || null,
        freshCycles: searchReport?.data?.freshCycles || validationReport?.data?.freshCycles || null,
      },
    };
  }

  storeCandidate(payload) {
    const now = new Date().toISOString();
    const candidate = {
      id: payload.outPrefix,
      createdAt: now,
      trigger: payload.trigger,
      status: payload.recommendation.verdict === 'REVIEW_CANDIDATE' ? 'PENDING_REVIEW' : 'STORED_REJECTED_BY_GATES',
      autoDeployEnabled: false,
      manualPromotionRequired: true,
      strategyFile: path.relative(this.root, payload.strategyPath),
      reportFile: path.relative(this.root, payload.reportPath),
      freshDataFile: path.relative(this.root, payload.freshPath),
      validationFile: path.relative(this.root, payload.validationPath),
      cycleUpdate: payload.cycleUpdate,
      recommendation: payload.recommendation,
      strategy: {
        name: payload.strategy?.name || null,
        count: Array.isArray(payload.strategy?.strategies) ? payload.strategy.strategies.length : 0,
        full: payload.strategy || null,
        strategies: Array.isArray(payload.strategy?.strategies) ? payload.strategy.strategies.map((s) => ({
          name: s.name,
          asset: s.asset,
          utcHour: s.utcHour,
          entryMinute: s.entryMinute,
          direction: s.direction,
          priceMin: s.priceMin,
          priceMax: s.priceMax,
          pWinEstimate: s.pWinEstimate,
          winRate: s.winRate,
          winRateLCB: s.winRateLCB,
        })) : [],
      },
      validationSummary: {
        windows: payload.validation?.windows || null,
        stress: payload.validation?.stress || null,
        bootstrapFreshHoldoutDays: payload.validation?.bootstrapFreshHoldoutDays || null,
      },
      reportSummary: {
        data: payload.report?.data || null,
        config: payload.report?.config || null,
        mining: payload.report?.mining || null,
        bootstrap: payload.report?.bootstrap || null,
      },
      commandResults: {
        searchCode: payload.search?.code ?? null,
        validationCode: payload.validationRun?.code ?? null,
      },
    };
    this.state.candidates.push(candidate);
    this.persist();
    return candidate;
  }

  buildSummaryLines(candidate) {
    const rec = candidate?.recommendation || {};
    const m = rec.metrics || {};
    const lines = [
      `Candidate: ${candidate?.id}`,
      `Verdict: ${rec.verdict || 'UNKNOWN'} (manual promotion required)`,
      `Strategy: ${candidate?.strategyFile}`,
      `Validation: ${candidate?.validationFile}`,
      `Count: ${m.strategyCount ?? '?'} | minPWin: ${m.minPWin ?? '?'} | 7d WR: ${m.wr7d ?? '?'} | 7d final: $${m.final7d ?? '?'}`,
      `Bust7d: ${m.bust7d ?? '?'} | MaxDD7d: ${m.maxDd7d ?? '?'}`,
    ];
    if (candidate?.cycleUpdate) lines.push(`Cycle data: +${candidate.cycleUpdate.added} cycles (${candidate.cycleUpdate.afterCount} total)`);
    if (Array.isArray(rec.issues) && rec.issues.length) lines.push(`Issues: ${rec.issues.join(', ')}`);
    return lines;
  }

  async notifyCandidate(candidate, lines, recommendation) {
    if (!this.telegram) return;
    const summary = lines.join('\n');
    if (this.telegram.notifyRetrainCandidate) {
      this.telegram.notifyRetrainCandidate({
        candidateFile: candidate?.strategyFile,
        beatsCurrent: !!recommendation?.beatsCurrent,
        summary,
      });
      return;
    }
    if (this.telegram.sendMessage) {
      this.telegram.sendMessage(summary, this.telegram.PRIORITY?.HIGH || 'HIGH');
    }
  }

  list(limit = 10) {
    const n = Math.max(1, Math.min(50, Number(limit) || 10));
    return this.state.candidates.slice(-n).reverse();
  }

  get(candidateId) {
    return this.state.candidates.find((candidate) => candidate.id === candidateId) || null;
  }

  decide(candidateId, decision, options = {}) {
    const candidate = this.get(candidateId);
    if (!candidate) throw new Error('CANDIDATE_NOT_FOUND');
    const normalized = String(decision || '').trim().toUpperCase();
    if (!['ACCEPT', 'DECLINE'].includes(normalized)) throw new Error('UNSUPPORTED_DECISION');
    const record = {
      candidateId,
      decision: normalized,
      decidedAt: new Date().toISOString(),
      operator: String(options.operator || 'api'),
      notes: String(options.notes || '').slice(0, 1000),
      autoDeployPerformed: false,
      nextAction: normalized === 'ACCEPT'
        ? `Manual promotion only: set STRATEGY_SET_15M_PATH=${candidate.strategyFile}, deploy paused, then reset validator baseline.`
        : 'Candidate retained for future analysis; no live config changed.',
    };
    candidate.status = normalized === 'ACCEPT' ? 'ACCEPTED_MANUAL_PROMOTION_PENDING' : 'DECLINED_RETAINED';
    candidate.decision = record;
    this.state.decisions.push(record);
    if (normalized === 'DECLINE') this.state.declineLog.push(record);
    this.persist();
    this.diagnostic('STRATEGY_AUTOPILOT_DECISION', record);
    if (this.telegram?.sendMessage) {
      this.telegram.sendMessage(
        `${normalized === 'ACCEPT' ? '✅' : '🛑'} <b>STRATEGY CANDIDATE ${normalized}</b>\n` +
        `Candidate: <code>${candidateId}</code>\n` +
        `Auto-deploy: <b>NO</b>\n` +
        `${record.nextAction}`,
        this.telegram.PRIORITY?.HIGH || 'HIGH',
      );
    }
    return record;
  }

  status() {
    return {
      enabled: this.enabled,
      running: this.running,
      autoDeployEnabled: false,
      cadence: {
        intervalHours: this.intervalHours,
        utcHour: this.utcHour,
        utcMinute: this.utcMinute,
        checkIntervalMs: this.checkIntervalMs,
        minRunGapMs: this.minRunGapMs,
      },
      config: {
        fetchDays: this.fetchDays,
        holdoutDays: this.holdoutDays,
        maxStrategies: this.maxStrategies,
        minReviewPWin: this.minReviewPWin,
        minReviewWr: this.minReviewWr,
        maxReviewBustRate: this.maxReviewBustRate,
        updateCycleData: this.updateCycleData,
      },
      statePath: path.relative(this.root, this.statePath),
      lastRunAt: this.state.lastRunAt || null,
      lastCompletedAt: this.state.lastCompletedAt || null,
      lastError: this.state.lastError || null,
      lastCandidateId: this.state.lastCandidateId || null,
      candidateCount: this.state.candidates.length,
      latestCandidate: this.state.candidates.length ? this.state.candidates[this.state.candidates.length - 1] : null,
    };
  }
}

module.exports = StrategyAutopilot;
