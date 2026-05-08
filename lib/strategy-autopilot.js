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

function compactStamp(date = new Date()) {
    return date.toISOString().slice(0, 19).replace(/[-:T]/g, '');
}

function round(value, digits = 4) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return null;
    return Math.round(parsed * (10 ** digits)) / (10 ** digits);
}

function rel(root, filePath) {
    return filePath ? path.relative(root, filePath).replace(/\\/g, '/') : null;
}

function safeOutputStem(value) {
    return path.basename(String(value || 'strategy'), '.json').replace(/[^a-z0-9_-]+/gi, '_').toLowerCase();
}

function safeStrategyPath(root, filePath) {
    const raw = String(filePath || '').trim();
    if (!raw) return null;
    const abs = path.isAbsolute(raw) ? raw : path.join(root, raw);
    const normalizedRoot = path.resolve(root);
    const normalizedAbs = path.resolve(abs);
    if (!normalizedAbs.startsWith(normalizedRoot + path.sep) && normalizedAbs !== normalizedRoot) return null;
    if (!/\.json$/i.test(normalizedAbs)) return null;
    return normalizedAbs;
}

function wilsonLowerBound(wins, total, z = 1.96) {
    const n = Number(total || 0);
    if (!n) return 0;
    const p = Number(wins || 0) / n;
    const z2 = z * z;
    return (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / (1 + z2 / n);
}

function summariseSelectedAudit(summary, ids) {
    const selected = new Set((ids || []).map((id) => String(id)));
    const rows = Object.values(summary?.byStrategy || {}).filter((row) => selected.has(String(row.id)));
    const triggered = rows.reduce((sum, row) => sum + Number(row.triggered || 0), 0);
    const wins = rows.reduce((sum, row) => sum + Number(row.wins || 0), 0);
    const weightedPnl = rows.reduce((sum, row) => sum + (Number(row.avgPnlPerShare || 0) * Number(row.triggered || 0)), 0);
    const ruleTriggers = rows.map((row) => Number(row.triggered || 0));
    const weakRules = rows.filter((row) => {
        const ruleTriggered = Number(row.triggered || 0);
        const ruleWins = Number(row.wins || 0);
        const rulePnl = Number(row.avgPnlPerShare || 0);
        return ruleTriggered < 10 || wilsonLowerBound(ruleWins, ruleTriggered) < 0.5 || rulePnl <= 0;
    }).map((row) => row.id);
    return {
        rules: rows.length,
        triggered,
        wins,
        losses: Math.max(0, triggered - wins),
        winRate: triggered ? wins / triggered : null,
        winRateLcb95: wilsonLowerBound(wins, triggered),
        avgPnlPerShare: triggered ? weightedPnl / triggered : null,
        minRuleTriggers: ruleTriggers.length ? Math.min(...ruleTriggers) : 0,
        weakRuleIds: weakRules,
        ids: rows.map((row) => row.id)
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
        this.enabled = parseBool(process.env.STRATEGY_AUTOPILOT_ENABLED, false);
        this.intervalHours = Math.max(1, parseNumber(process.env.STRATEGY_AUTOPILOT_INTERVAL_HOURS, 24));
        this.utcHour = Math.max(0, Math.min(23, parseNumber(process.env.STRATEGY_AUTOPILOT_UTC_HOUR, 5)));
        this.utcMinute = Math.max(0, Math.min(59, parseNumber(process.env.STRATEGY_AUTOPILOT_UTC_MINUTE, 20)));
        this.checkIntervalMs = Math.max(60_000, parseNumber(process.env.STRATEGY_AUTOPILOT_CHECK_MS, 10 * 60 * 1000));
        this.minRunGapMs = Math.max(60 * 60 * 1000, parseNumber(process.env.STRATEGY_AUTOPILOT_MIN_GAP_MS, this.intervalHours * 60 * 60 * 1000));
        this.timeoutMs = Math.max(5 * 60 * 1000, parseNumber(process.env.STRATEGY_AUTOPILOT_TIMEOUT_MS, 60 * 60 * 1000));
        this.datasetTimeoutMs = Math.max(5 * 60 * 1000, parseNumber(process.env.STRATEGY_AUTOPILOT_DATASET_TIMEOUT_MS, 75 * 60 * 1000));
        this.pipelineMode = String(process.env.STRATEGY_AUTOPILOT_PIPELINE || 'FRESH_AUDIT_PRUNE').trim().toUpperCase();
        this.auditDays = Math.max(1, Math.min(14, parseNumber(process.env.STRATEGY_AUTOPILOT_AUDIT_DAYS, 3)));
        this.auditSourceStrategyFile = String(process.env.STRATEGY_AUTOPILOT_SOURCE_STRATEGY_FILE || process.env.STRATEGY_SET_15M_SOURCE_PATH || 'strategies/strategy_set_15m_epoch3v2_portfolio.json').trim();
        this.minPruneEvents = Math.max(1, parseNumber(process.env.STRATEGY_AUTOPILOT_MIN_RULE_TRIGGERS, 3));
        this.minPruneWinRate = Math.max(0.5, Math.min(1, parseNumber(process.env.STRATEGY_AUTOPILOT_MIN_RULE_WR, 0.75)));
        this.minPruneAvgPnl = parseNumber(process.env.STRATEGY_AUTOPILOT_MIN_RULE_AVG_PNL, 0);
        this.minReviewTotalTriggers = Math.max(20, parseNumber(process.env.STRATEGY_AUTOPILOT_MIN_REVIEW_TRIGGERS, 100));
        this.minReviewRuleTriggers = Math.max(this.minPruneEvents, parseNumber(process.env.STRATEGY_AUTOPILOT_MIN_REVIEW_RULE_TRIGGERS, 10));
        this.minReviewLcb = Math.max(0, Math.min(1, parseNumber(process.env.STRATEGY_AUTOPILOT_MIN_REVIEW_LCB95, 0.5)));
        this.minImprovementPnl = Math.max(0, parseNumber(process.env.STRATEGY_AUTOPILOT_MIN_PNL_IMPROVEMENT, 0.01));
        this.minerMode = String(process.env.STRATEGY_AUTOPILOT_MINER_MODE || 'FAST').trim().toUpperCase();
        this.candidateLimit = Math.max(100, parseNumber(process.env.STRATEGY_AUTOPILOT_CANDIDATE_LIMIT, 50000));
        this.monteCarloRuns = Math.max(50, parseNumber(process.env.STRATEGY_AUTOPILOT_MONTE_CARLO_RUNS, 300));
        this.maxNewCycles = Math.max(0, parseNumber(process.env.STRATEGY_AUTOPILOT_MAX_NEW_CYCLES, 420));
        this.lookbackCycles = Math.max(10, parseNumber(process.env.STRATEGY_AUTOPILOT_LOOKBACK_CYCLES, 3000));
        this.updateCycleData = parseBool(process.env.STRATEGY_AUTOPILOT_UPDATE_CYCLE_DATA, true);
        this.minReviewHoldoutWr = Math.max(0, Math.min(1, parseNumber(process.env.STRATEGY_AUTOPILOT_MIN_HOLDOUT_WR, 0.78)));
        this.maxReviewBustPct = Math.max(0, parseNumber(process.env.STRATEGY_AUTOPILOT_MAX_BUST_PCT, 40));
        this.minReviewMedian = Math.max(0, parseNumber(process.env.STRATEGY_AUTOPILOT_MIN_STRICT_MEDIAN, 100));
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
            decisions: []
        };
        const parsed = safeReadJson(this.statePath, fallback) || fallback;
        parsed.version = 1;
        parsed.enabled = this.enabled;
        parsed.autoDeployEnabled = false;
        parsed.candidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
        parsed.decisions = Array.isArray(parsed.decisions) ? parsed.decisions : [];
        return parsed;
    }

    importState(state = {}) {
        if (!state || typeof state !== 'object') return;
        if (Array.isArray(state.candidates)) this.state.candidates = state.candidates;
        if (Array.isArray(state.decisions)) this.state.decisions = state.decisions;
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
            decisions: this.state.decisions.slice(-100)
        };
    }

    persist() {
        this.state.enabled = this.enabled;
        this.state.autoDeployEnabled = false;
        this.state.candidates = this.state.candidates.slice(-25);
        this.state.decisions = this.state.decisions.slice(-100);
        writeJson(this.statePath, this.state);
        if (this.onStateChange) Promise.resolve(this.onStateChange()).catch(() => null);
    }

    diagnostic(type, payload = {}) {
        if (this.appendDiagnostic) this.appendDiagnostic({ ts: new Date().toISOString(), type, ...payload });
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
        if (!this.enabled) return { ok: false, reason: 'DISABLED' };
        if (this.running) return { ok: false, reason: 'RUNNING' };
        const last = this.state.lastCompletedAt ? new Date(this.state.lastCompletedAt).getTime() : 0;
        const now = Date.now();
        if (last && now - last < this.minRunGapMs) return { ok: false, reason: 'MIN_GAP', nextEligibleAt: new Date(last + this.minRunGapMs).toISOString() };
        const d = new Date();
        const afterWindow = d.getUTCHours() > this.utcHour || (d.getUTCHours() === this.utcHour && d.getUTCMinutes() >= this.utcMinute);
        if (!afterWindow && last) return { ok: false, reason: 'BEFORE_DAILY_WINDOW' };
        return { ok: true };
    }

    async maybeRun(trigger = 'SCHEDULE') {
        const eligibility = this.shouldRunNow();
        if (!eligibility.ok) return { skipped: true, ...eligibility };
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
            this.notifyCandidate(result.candidate).catch(() => null);
            this.diagnostic('STRATEGY_AUTOPILOT_COMPLETED', { trigger, candidateId: result.candidate?.id || null, verdict: result.candidate?.recommendation?.verdict || null });
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
                windowsHide: true
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
        if (this.pipelineMode !== 'LEGACY_MEGA_MINER') {
            return this.runFreshAuditPrunePipeline(trigger, startedAt);
        }
        const runId = `autopilot_${compactStamp(startedAt)}`;
        const runDir = path.join('debug', 'strategy_autopilot', runId);
        let dataset = null;
        if (this.updateCycleData) dataset = await this.runDatasetUpdate(runId);
        const miner = await this.runMiner(runDir);
        const validator = await this.runActiveStrategyValidator(runDir);
        const candidate = this.storeCandidate({ runId, runDir, trigger, startedAt, dataset, miner, validator });
        return { candidate };
    }

    async runFreshAudit(strategyFile, runDir, label) {
        const strategyAbs = safeStrategyPath(this.root, strategyFile);
        if (!strategyAbs || !fs.existsSync(strategyAbs)) throw new Error(`STRATEGY_FILE_NOT_FOUND ${strategyFile}`);
        const strategyRelPath = rel(this.root, strategyAbs);
        const env = {
            STRATEGY_FILE: strategyRelPath,
            RECENT_DAYS: String(this.auditDays)
        };
        const result = await this.runCommand(process.execPath, ['scripts/fresh-15m-strategy-audit.js'], { env, timeoutMs: this.timeoutMs });
        if (result.code !== 0) throw new Error(`FRESH_AUDIT_FAILED ${label} code=${result.code} ${result.stderr || result.stdout || ''}`.slice(0, 2000));
        const reportPath = path.join(this.root, 'epoch3', 'reinvestigation_v2', `fresh_15m_strategy_audit_${safeOutputStem(strategyRelPath)}_${this.auditDays}d.json`);
        const report = safeReadJson(reportPath, null);
        if (!report?.summary) throw new Error(`FRESH_AUDIT_REPORT_MISSING ${rel(this.root, reportPath)}`);
        const snapshotPath = path.join(this.root, runDir, `${label}_fresh_audit.json`);
        writeJson(snapshotPath, report);
        return {
            commandCode: result.code,
            strategyFile: strategyRelPath,
            reportFile: rel(this.root, reportPath),
            snapshotFile: rel(this.root, snapshotPath),
            summary: report.summary,
            results: Array.isArray(report.results) ? report.results : []
        };
    }

    buildPrunedStrategyArtifact(sourceAudit, runId) {
        const sourceAbs = safeStrategyPath(this.root, sourceAudit.strategyFile);
        const sourceData = JSON.parse(fs.readFileSync(sourceAbs, 'utf8'));
        const sourceStrategies = Array.isArray(sourceData.strategies) ? sourceData.strategies : [];
        const byStrategy = sourceAudit.summary?.byStrategy || {};
        const selected = sourceStrategies.filter((strategy) => {
            const row = byStrategy[String(strategy.id)];
            const triggered = Number(row?.triggered || 0);
            const winRate = Number(row?.winRate || 0);
            const avgPnl = Number(row?.avgPnlPerShare || 0);
            return triggered >= this.minPruneEvents && winRate >= this.minPruneWinRate && avgPnl > this.minPruneAvgPnl;
        });
        const outRel = path.join('strategies', `strategy_set_15m_autopilot_pruned_${compactStamp()}.json`).replace(/\\/g, '/');
        const outAbs = path.join(this.root, outRel);
        const output = {
            ...sourceData,
            generatedAt: new Date().toISOString(),
            sourceStrategyFile: sourceAudit.strategyFile,
            method: 'strategy-autopilot fresh-audit prune; no profit guarantee; operator approval required',
            selectionCriteria: {
                recentDays: this.auditDays,
                minRuleTriggers: this.minPruneEvents,
                minRuleWinRate: this.minPruneWinRate,
                minRuleAvgPnlPerShare: this.minPruneAvgPnl,
                fillModel: 'fresh-15m-strategy-audit adverse entry price, fee and slippage assumptions'
            },
            stats: {
                ...(sourceData.stats || {}),
                autopilotRunId: runId,
                selectedRules: selected.length,
                sourceRules: sourceStrategies.length,
                recentAudit: summariseSelectedAudit(sourceAudit.summary, selected.map((strategy) => strategy.id))
            },
            strategies: selected.map((strategy) => ({
                ...strategy,
                autopilotFreshAudit: byStrategy[String(strategy.id)] || null
            }))
        };
        writeJson(outAbs, output);
        return { file: outRel, abs: outAbs, data: output };
    }

    evaluateFreshAuditCandidate(currentAudit, sourceAudit, artifact) {
        const candidateSummary = summariseSelectedAudit(sourceAudit.summary, artifact.data.strategies.map((strategy) => strategy.id));
        const currentIds = Object.keys(currentAudit.summary?.byStrategy || {});
        const currentSummary = summariseSelectedAudit(currentAudit.summary, currentIds);
        const issues = [];
        if (!candidateSummary.rules) issues.push('NO_RULES_PASSED_FRESH_PRUNE_GATES');
        if ((candidateSummary.triggered || 0) < this.minReviewTotalTriggers) issues.push('CANDIDATE_SAMPLE_TOO_SMALL_FOR_REVIEW');
        if ((currentSummary.triggered || 0) < this.minReviewTotalTriggers) issues.push('CURRENT_SAMPLE_TOO_SMALL_FOR_CONFIDENT_BASELINE');
        if ((candidateSummary.minRuleTriggers || 0) < this.minReviewRuleTriggers) issues.push('CANDIDATE_RULE_SAMPLE_TOO_SMALL');
        if ((candidateSummary.winRateLcb95 || 0) < this.minReviewLcb) issues.push('CANDIDATE_LCB95_TOO_LOW');
        if (candidateSummary.weakRuleIds?.length) issues.push('CANDIDATE_HAS_WEAK_RULES');
        if (candidateSummary.winRate !== null && currentSummary.winRate !== null && candidateSummary.winRate <= currentSummary.winRate) issues.push('DOES_NOT_BEAT_CURRENT_WIN_RATE');
        if (candidateSummary.avgPnlPerShare !== null && currentSummary.avgPnlPerShare !== null && candidateSummary.avgPnlPerShare <= currentSummary.avgPnlPerShare + this.minImprovementPnl) issues.push('DOES_NOT_BEAT_CURRENT_AVG_PNL_BY_MARGIN');
        const hardIssues = new Set([
            'NO_RULES_PASSED_FRESH_PRUNE_GATES',
            'CANDIDATE_SAMPLE_TOO_SMALL_FOR_REVIEW',
            'CANDIDATE_RULE_SAMPLE_TOO_SMALL',
            'CANDIDATE_LCB95_TOO_LOW',
            'CANDIDATE_HAS_WEAK_RULES',
            'DOES_NOT_BEAT_CURRENT_WIN_RATE',
            'DOES_NOT_BEAT_CURRENT_AVG_PNL_BY_MARGIN'
        ]);
        const reviewable = candidateSummary.rules > 0 && !issues.some((issue) => hardIssues.has(issue));
        return {
            verdict: reviewable ? 'REVIEW_CANDIDATE' : 'STORE_ONLY',
            beatsCurrent: reviewable,
            safeForAutoDeploy: false,
            manualPromotionRequired: true,
            issues,
            guardrails: {
                minReviewTotalTriggers: this.minReviewTotalTriggers,
                minReviewRuleTriggers: this.minReviewRuleTriggers,
                minReviewLcb95: this.minReviewLcb,
                minAvgPnlImprovement: this.minImprovementPnl,
                note: 'Autopilot can store candidates, but it must not auto-deploy or imply profit certainty from sparse samples.'
            },
            metrics: {
                candidateRules: candidateSummary.rules,
                candidateTriggered: candidateSummary.triggered,
                candidateWins: candidateSummary.wins,
                candidateWinRate: round(candidateSummary.winRate, 4),
                candidateWinRateLcb95: round(candidateSummary.winRateLcb95, 4),
                candidateAvgPnlPerShare: round(candidateSummary.avgPnlPerShare, 4),
                candidateMinRuleTriggers: candidateSummary.minRuleTriggers,
                candidateWeakRuleIds: candidateSummary.weakRuleIds,
                currentRules: currentSummary.rules,
                currentTriggered: currentSummary.triggered,
                currentWins: currentSummary.wins,
                currentWinRate: round(currentSummary.winRate, 4),
                currentWinRateLcb95: round(currentSummary.winRateLcb95, 4),
                currentAvgPnlPerShare: round(currentSummary.avgPnlPerShare, 4)
            }
        };
    }

    async runFreshAuditPrunePipeline(trigger, startedAt) {
        const runId = `autopilot_${compactStamp(startedAt)}`;
        const runDir = path.join('debug', 'strategy_autopilot', runId);
        const context = this.getRuntimeContext() || {};
        const activeFiles = Array.isArray(context.activeStrategyFiles) ? context.activeStrategyFiles : [];
        const currentFile = activeFiles.find((filePath) => String(filePath || '').includes('15m')) || activeFiles[0] || process.env.STRATEGY_SET_15M_PATH;
        const currentAudit = await this.runFreshAudit(currentFile, runDir, 'current');
        const sourceAudit = await this.runFreshAudit(this.auditSourceStrategyFile || currentFile, runDir, 'source');
        const artifact = this.buildPrunedStrategyArtifact(sourceAudit, runId);
        const recommendation = this.evaluateFreshAuditCandidate(currentAudit, sourceAudit, artifact);
        const candidate = {
            id: runId,
            createdAt: new Date().toISOString(),
            trigger,
            status: recommendation.verdict === 'REVIEW_CANDIDATE' ? 'PENDING_REVIEW' : 'STORED_RESEARCH_ONLY',
            autoDeployEnabled: false,
            manualPromotionRequired: true,
            candidateType: 'FRESH_AUDIT_PRUNED_RUNTIME_STRATEGY',
            runtimeStrategyFile: artifact.file,
            runDir,
            artifacts: {
                currentAuditFile: currentAudit.snapshotFile || currentAudit.reportFile,
                sourceAuditFile: sourceAudit.snapshotFile || sourceAudit.reportFile,
                runtimeStrategyFile: artifact.file
            },
            recommendation,
            comparison: {
                current: currentAudit.summary,
                source: sourceAudit.summary,
                candidate: artifact.data.stats.recentAudit
            },
            strategyPreview: artifact.data.strategies.map((strategy) => ({
                id: strategy.id,
                name: strategy.name,
                asset: strategy.asset,
                direction: strategy.direction,
                utcHour: strategy.utcHour,
                entryMinute: strategy.entryMinute,
                priceMin: strategy.priceMin,
                priceMax: strategy.priceMax,
                freshAudit: strategy.autopilotFreshAudit
            })),
            methodWarnings: [
                'Fresh audit is recent historical validation, not prophecy.',
                'Promotion requires explicit operator acceptance.',
                'Small samples are flagged and must not be treated as certainty.'
            ],
            commandResults: {
                currentAuditCode: currentAudit.commandCode,
                sourceAuditCode: sourceAudit.commandCode
            }
        };
        this.state.candidates.push(candidate);
        this.persist();
        return { candidate };
    }

    async runDatasetUpdate(runId) {
        const env = {
            EPOCH3_EXPAND_FETCH: 'true',
            EPOCH3_EXPAND_INCLUDE_EXISTING: 'true',
            EPOCH3_EXPAND_MAX_NEW_CYCLES: String(this.maxNewCycles),
            EPOCH3_EXPAND_LOOKBACK_CYCLES: String(this.lookbackCycles)
        };
        const result = await this.runCommand(process.execPath, ['scripts/epoch3_dataset_expander.js'], { env, timeoutMs: this.datasetTimeoutMs });
        const auditPath = path.join(this.root, 'debug', 'epoch3_dataset_expander', 'latest_audit.json');
        const expandedPath = path.join(this.root, 'data', 'epoch3-expanded-intracycle-data.json');
        const audit = safeReadJson(auditPath, null);
        const snapshotPath = path.join(this.root, 'debug', 'strategy_autopilot', runId, 'dataset_audit.json');
        if (audit) writeJson(snapshotPath, audit);
        return {
            commandCode: result.code,
            outputFile: rel(this.root, expandedPath),
            auditFile: rel(this.root, auditPath),
            snapshotFile: audit ? rel(this.root, snapshotPath) : null,
            audit
        };
    }

    async runMiner(runDir) {
        const env = {
            EPOCH3_MEGA_MODE: this.minerMode,
            EPOCH3_MEGA_OUT_DIR: runDir,
            EPOCH3_CANDIDATE_LIMIT: String(this.candidateLimit),
            EPOCH3_MONTE_CARLO_RUNS: String(this.monteCarloRuns),
            EPOCH3_APPEND_README_CANDIDATES: 'false'
        };
        const result = await this.runCommand(process.execPath, ['scripts/epoch3_mega_strategy_miner.js'], { env, timeoutMs: this.timeoutMs });
        const outDir = path.join(this.root, runDir);
        const rollingCandidatesPath = path.join(outDir, 'rolling_candidates.json');
        const rollingDiagnosticsPath = path.join(outDir, 'rolling_diagnostics.json');
        const statePath = path.join(outDir, 'mega_miner_state.json');
        const dataAuditPath = path.join(outDir, 'epoch3_data_audit.json');
        const candidates = safeReadJson(rollingCandidatesPath, []) || [];
        const diagnostics = safeReadJson(rollingDiagnosticsPath, []) || [];
        const state = safeReadJson(statePath, null);
        const dataAudit = safeReadJson(dataAuditPath, null);
        return {
            commandCode: result.code,
            outDir: rel(this.root, outDir),
            rollingCandidatesFile: rel(this.root, rollingCandidatesPath),
            rollingDiagnosticsFile: rel(this.root, rollingDiagnosticsPath),
            stateFile: rel(this.root, statePath),
            dataAuditFile: rel(this.root, dataAuditPath),
            candidates,
            diagnostics,
            state,
            dataAudit
        };
    }

    async runActiveStrategyValidator(runDir) {
        const context = this.getRuntimeContext() || {};
        const activeFiles = Array.isArray(context.activeStrategyFiles) ? context.activeStrategyFiles : [];
        const selected = activeFiles.find((filePath) => String(filePath || '').includes('15m')) || activeFiles[0] || null;
        if (!selected) return { skipped: true, reason: 'NO_ACTIVE_STRATEGY_FILE' };
        const strategyRelPath = path.isAbsolute(selected) ? rel(this.root, selected) : selected;
        const env = {
            VERIFY_STRATEGY_PATH: strategyRelPath,
            START_BALANCE: String(Math.max(2, Number(context.bankroll || process.env.START_BALANCE || 6.44)))
        };
        const result = await this.runCommand(process.execPath, ['scripts/reverify-beam-strategy.js'], { env, timeoutMs: this.timeoutMs });
        const reportPath = path.join(this.root, 'debug', 'reverify_strategy_report.json');
        const report = safeReadJson(reportPath, null);
        const snapshotPath = path.join(this.root, runDir, 'active_strategy_reverify_report.json');
        if (report) writeJson(snapshotPath, report);
        return {
            commandCode: result.code,
            strategyFile: strategyRelPath,
            reportFile: rel(this.root, reportPath),
            snapshotFile: report ? rel(this.root, snapshotPath) : null,
            report
        };
    }

    evaluateTopCandidate(top) {
        if (!top) {
            return {
                verdict: 'STORE_ONLY',
                beatsCurrent: false,
                safeForAutoDeploy: false,
                manualPromotionRequired: true,
                issues: ['NO_HIGH_GROWTH_CANDIDATES'],
                metrics: {}
            };
        }
        const holdoutWr = Number(top.holdout?.wr ?? 0);
        const bustStrict = Number(top.bustStrict ?? 100);
        const medianStrict = Number(top.medianStrict ?? 0);
        const issues = [];
        if (!(holdoutWr >= this.minReviewHoldoutWr)) issues.push(`HOLDOUT_WR_BELOW_${this.minReviewHoldoutWr}`);
        if (!(bustStrict <= this.maxReviewBustPct)) issues.push(`BUST_STRICT_ABOVE_${this.maxReviewBustPct}`);
        if (!(medianStrict >= this.minReviewMedian)) issues.push(`STRICT_MEDIAN_BELOW_${this.minReviewMedian}`);
        return {
            verdict: issues.length ? 'STORE_ONLY' : 'REVIEW_CANDIDATE',
            beatsCurrent: issues.length === 0,
            safeForAutoDeploy: false,
            manualPromotionRequired: true,
            issues,
            metrics: {
                score: round(top.score, 4),
                holdoutWr: round(holdoutWr, 4),
                holdoutN: Number(top.holdout?.n || 0),
                medianStrict: round(medianStrict, 2),
                p75Strict: round(top.p75Strict, 2),
                p90Strict: round(top.p90Strict, 2),
                bustStrict: round(bustStrict, 2),
                worstMedian: round(top.worstMedian, 2),
                baseChronologicalFinal: round(top.baseChronologicalFinal, 2)
            }
        };
    }

    findFullCandidate(payload, top) {
        if (!top?.id || !payload?.miner?.outDir) return { file: null, value: null };
        const fullPath = path.join(this.root, payload.miner.outDir, `candidate_${top.id}.json`);
        return { file: fs.existsSync(fullPath) ? rel(this.root, fullPath) : null, value: safeReadJson(fullPath, null) };
    }

    storeCandidate(payload) {
        const top = Array.isArray(payload.miner.candidates) && payload.miner.candidates.length ? payload.miner.candidates[0] : null;
        const fullCandidate = this.findFullCandidate(payload, top);
        const recommendation = this.evaluateTopCandidate(top);
        const candidate = {
            id: payload.runId,
            createdAt: new Date().toISOString(),
            trigger: payload.trigger,
            status: recommendation.verdict === 'REVIEW_CANDIDATE' ? 'PENDING_REVIEW' : 'STORED_RESEARCH_ONLY',
            autoDeployEnabled: false,
            manualPromotionRequired: true,
            candidateType: 'EPOCH3_MEGA_MINER_RULE_CANDIDATE',
            runtimeStrategyFile: null,
            runDir: payload.miner.outDir,
            artifacts: {
                rollingCandidatesFile: payload.miner.rollingCandidatesFile,
                rollingDiagnosticsFile: payload.miner.rollingDiagnosticsFile,
                minerStateFile: payload.miner.stateFile,
                minerDataAuditFile: payload.miner.dataAuditFile,
                fullCandidateFile: fullCandidate.file,
                datasetAuditFile: payload.dataset?.snapshotFile || payload.dataset?.auditFile || null,
                expandedDatasetFile: payload.dataset?.outputFile || null,
                activeStrategyReverifyReportFile: payload.validator?.snapshotFile || payload.validator?.reportFile || null
            },
            recommendation,
            topCandidate: top,
            fullCandidate: fullCandidate.value,
            candidateCount: Array.isArray(payload.miner.candidates) ? payload.miner.candidates.length : 0,
            diagnosticCount: Array.isArray(payload.miner.diagnostics) ? payload.miner.diagnostics.length : 0,
            topCandidates: Array.isArray(payload.miner.candidates) ? payload.miner.candidates.slice(0, 10) : [],
            topDiagnostics: Array.isArray(payload.miner.diagnostics) ? payload.miner.diagnostics.slice(0, 10) : [],
            datasetSummary: payload.dataset?.audit ? {
                generatedAt: payload.dataset.audit.generatedAt || null,
                totalCycles: payload.dataset.audit.totalCycles || payload.dataset.audit.cycleCount || null,
                freshnessHours: payload.dataset.audit.freshnessHours ?? null,
                firstIso: payload.dataset.audit.firstIso || null,
                lastIso: payload.dataset.audit.lastIso || null,
                warnings: payload.dataset.audit.warnings || []
            } : null,
            minerSummary: payload.miner.state ? {
                startedAt: payload.miner.state.startedAt || null,
                finishedAt: payload.miner.state.finishedAt || null,
                mode: payload.miner.state.mode || this.minerMode,
                evaluated: payload.miner.state.evaluated || 0,
                trainPassed: payload.miner.state.trainPassed || 0,
                rollingCandidates: payload.miner.state.rollingCandidates || 0,
                breakthroughCandidates: payload.miner.state.breakthroughCandidates || 0,
                diagnosticCandidates: payload.miner.state.diagnosticCandidates || 0,
                completed: !!payload.miner.state.completed
            } : null,
            activeStrategyValidation: payload.validator ? {
                skipped: !!payload.validator.skipped,
                reason: payload.validator.reason || null,
                strategyFile: payload.validator.strategyFile || null,
                commandCode: payload.validator.commandCode ?? null,
                reportGeneratedAt: payload.validator.report?.generatedAt || payload.validator.report?.ts || null,
                verdict: payload.validator.report?.verdict || payload.validator.report?.recommendation || null,
                report: payload.validator.report || null
            } : null,
            commandResults: {
                datasetCode: payload.dataset?.commandCode ?? null,
                minerCode: payload.miner.commandCode ?? null,
                validatorCode: payload.validator?.commandCode ?? null
            }
        };
        this.state.candidates.push(candidate);
        this.persist();
        return candidate;
    }

    buildSummaryLines(candidate) {
        const rec = candidate?.recommendation || {};
        const metrics = rec.metrics || {};
        const top = candidate?.topCandidate || {};
        const lines = [
            `Candidate: ${candidate?.id}`,
            `Verdict: ${rec.verdict || 'UNKNOWN'} (notify-only, manual promotion required)`,
            `Type: ${candidate?.candidateType}`,
            `Family: ${top.family || 'none'} | ID: ${top.id || 'none'}`,
            `Holdout WR: ${metrics.holdoutWr ?? 'n/a'} | n=${metrics.holdoutN ?? 'n/a'} | strict median=$${metrics.medianStrict ?? 'n/a'} | bust=${metrics.bustStrict ?? 'n/a'}%`,
            `Run dir: ${candidate?.runDir}`,
            `Candidates: ${candidate?.candidateCount || 0} | Diagnostics: ${candidate?.diagnosticCount || 0}`,
            `Auto-deploy: NO`
        ];
        if (candidate?.datasetSummary) lines.push(`Dataset: ${candidate.datasetSummary.firstIso || 'n/a'} -> ${candidate.datasetSummary.lastIso || 'n/a'} freshnessHours=${candidate.datasetSummary.freshnessHours ?? 'n/a'}`);
        if (Array.isArray(rec.issues) && rec.issues.length) lines.push(`Issues: ${rec.issues.join(', ')}`);
        return lines;
    }

    async notifyCandidate(candidate) {
        if (!this.telegram || !candidate) return;
        const summary = this.buildSummaryLines(candidate).join('\n');
        if (this.telegram.notifyRetrainCandidate) {
            this.telegram.notifyRetrainCandidate({
                candidateFile: candidate.runDir || candidate.id,
                beatsCurrent: !!candidate.recommendation?.beatsCurrent,
                summary
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
        const activation = options.activation && typeof options.activation === 'object' ? options.activation : null;
        const record = {
            candidateId,
            decision: normalized,
            decidedAt: new Date().toISOString(),
            operator: String(options.operator || 'api'),
            notes: String(options.notes || '').slice(0, 1000),
            autoDeployPerformed: !!activation?.success,
            activation,
            nextAction: normalized === 'ACCEPT'
                ? (activation?.success
                    ? 'Runtime strategy artifact accepted and hot-loaded. Persist STRATEGY_SET_15M_PATH/Fly config before restart to make it durable.'
                    : 'Manual review accepted. Build/verify a runtime strategy artifact from this research candidate before changing STRATEGY_SET_15M_PATH.')
                : 'Candidate retained for future analysis; no live config changed.'
        };
        candidate.status = normalized === 'ACCEPT'
            ? (activation?.success ? 'ACCEPTED_RUNTIME_ACTIVE' : 'ACCEPTED_RESEARCH_MANUAL_BUILD_PENDING')
            : 'DECLINED_RETAINED';
        candidate.decision = record;
        if (activation?.success) {
            candidate.activatedAt = record.decidedAt;
            candidate.activeRuntimeStrategyFile = activation.strategyFile || candidate.runtimeStrategyFile || null;
        }
        this.state.decisions.push(record);
        this.persist();
        this.diagnostic('STRATEGY_AUTOPILOT_DECISION', record);
        if (this.telegram?.sendMessage) {
            this.telegram.sendMessage(`${normalized === 'ACCEPT' ? '✅' : '🛑'} <b>STRATEGY CANDIDATE ${normalized}</b>\nCandidate: <code>${candidateId}</code>\nRuntime hot-load: <b>${activation?.success ? 'YES' : 'NO'}</b>\n${record.nextAction}`, this.telegram.PRIORITY?.HIGH || 'HIGH');
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
                minRunGapMs: this.minRunGapMs
            },
            config: {
                pipelineMode: this.pipelineMode,
                auditDays: this.auditDays,
                auditSourceStrategyFile: this.auditSourceStrategyFile,
                minPruneEvents: this.minPruneEvents,
                minPruneWinRate: this.minPruneWinRate,
                minPruneAvgPnl: this.minPruneAvgPnl,
                updateCycleData: this.updateCycleData,
                minerMode: this.minerMode,
                candidateLimit: this.candidateLimit,
                monteCarloRuns: this.monteCarloRuns,
                maxNewCycles: this.maxNewCycles,
                lookbackCycles: this.lookbackCycles,
                minReviewHoldoutWr: this.minReviewHoldoutWr,
                maxReviewBustPct: this.maxReviewBustPct,
                minReviewMedian: this.minReviewMedian
            },
            statePath: rel(this.root, this.statePath),
            lastRunAt: this.state.lastRunAt || null,
            lastCompletedAt: this.state.lastCompletedAt || null,
            lastError: this.state.lastError || null,
            lastCandidateId: this.state.lastCandidateId || null,
            candidateCount: this.state.candidates.length,
            latestCandidate: this.state.candidates.length ? this.state.candidates[this.state.candidates.length - 1] : null
        };
    }
}

module.exports = StrategyAutopilot;
