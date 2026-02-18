const fs = require('fs');
const path = require('path');

function detectNewline(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function normalizeNewlines(text, nl) {
  return text.replace(/\r?\n/g, nl);
}

function buildProofBlock(title, jsonText, nl) {
  return `- **[${title}]**${nl}\`\`\`json${nl}${jsonText}${nl}\`\`\``;
}

function replaceExistingProofBlock(report, endpoint, newBlock) {
  const endpointEsc = endpoint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    '- \\*\\*\\[' + endpointEsc + '\\]\\*\\*\\s*```json\\s*[\\s\\S]*?\\s*```',
    'm'
  );

  if (!re.test(report)) {
    throw new Error(`Could not find existing proof block for ${endpoint}`);
  }

  return report.replace(re, newBlock);
}

function upsertProofBlockBeforeMarker(report, marker, endpoint, newBlock, nl) {
  const endpointEsc = endpoint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    '- \\*\\*\\[' + endpointEsc + '[^\\]]*\\]\\*\\*\\s*```json\\s*[\\s\\S]*?\\s*```',
    'm'
  );

  if (re.test(report)) {
    return report.replace(re, newBlock);
  }

  const idx = report.indexOf(marker);
  if (idx === -1) {
    throw new Error(`Could not find marker to insert before: ${marker}`);
  }

  return report.slice(0, idx) + newBlock + nl + nl + report.slice(idx);
}

function main() {
  const root = path.resolve(__dirname, '..');
  const reportPath = path.join(root, 'FINAL_HYBRID_STRATEGY_REPORT.md');
  const gatesPath = path.join(root, 'proof_gates.json');
  const statePath = path.join(root, 'proof_state.json');

  const reportOriginal = fs.readFileSync(reportPath, 'utf8');
  const nl = detectNewline(reportOriginal);

  const gatesJsonText = normalizeNewlines(fs.readFileSync(gatesPath, 'utf8').trim(), nl);
  const gatesBlock = buildProofBlock('/api/gates', gatesJsonText, nl);

  let report = reportOriginal;
  report = replaceExistingProofBlock(report, '/api/gates', gatesBlock);

  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const fg = state && state._finalGoldenStrategy ? state._finalGoldenStrategy : null;

  const eliteProof = {
    _finalGoldenStrategy: {
      eliteStrategies: fg ? fg.eliteStrategies : undefined,
      eliteStrategiesEnabled: fg ? fg.eliteStrategiesEnabled : undefined,
      elitePriceRange: fg ? fg.elitePriceRange : undefined,
      eliteStats: fg ? fg.eliteStats : undefined
    }
  };

  const eliteStrategies = eliteProof._finalGoldenStrategy.eliteStrategies;
  const eliteEnabled = eliteProof._finalGoldenStrategy.eliteStrategiesEnabled;
  const eliteTotal = eliteProof._finalGoldenStrategy.eliteStats
    ? eliteProof._finalGoldenStrategy.eliteStats.totalStrategies
    : null;

  if (!Array.isArray(eliteStrategies)) {
    throw new Error('Expected _finalGoldenStrategy.eliteStrategies to be an array in proof_state.json');
  }

  if (eliteStrategies.length !== 8) {
    throw new Error(`Expected 8 elite strategies but found ${eliteStrategies.length}`);
  }

  if (eliteEnabled !== true) {
    throw new Error(`Expected eliteStrategiesEnabled=true but found ${eliteEnabled}`);
  }

  if (eliteTotal !== 8) {
    throw new Error(`Expected eliteStats.totalStrategies=8 but found ${eliteTotal}`);
  }

  const stateJsonText = normalizeNewlines(JSON.stringify(eliteProof, null, 2), nl);
  const stateBlock = buildProofBlock('/api/state (authenticated)', stateJsonText, nl);

  report = upsertProofBlockBeforeMarker(report, '- **[/api/state-public]**', '/api/state', stateBlock, nl);

  const proofListOld = '`/api/version`, `/api/health`, `/api/gates`, `/api/state-public`, `/api/issued-signal-ledger`';
  const proofListNew = '`/api/version`, `/api/health`, `/api/gates`, `/api/state`, `/api/state-public`, `/api/issued-signal-ledger`';
  if (report.includes(proofListOld)) {
    report = report.replace(proofListOld, proofListNew);
  }

  if (report === reportOriginal) {
    console.log('No changes needed.');
    return;
  }

  fs.writeFileSync(reportPath, report, 'utf8');
  console.log('Updated FINAL_HYBRID_STRATEGY_REPORT.md (embedded full /api/gates + authenticated /api/state elite strategies proof).');
}

main();
