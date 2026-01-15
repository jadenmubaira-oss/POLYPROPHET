const fs = require('fs');
const content = fs.readFileSync('server.js', 'utf8');
const lines = content.split('\n');
console.log('--- SEARCH STARTED ---');
let matches = 0;
lines.forEach((line, i) => {
    if (matches > 100) return;
    const t = line.trim();
    // Find initialization of CONFIG
    if (t.includes('const CONFIG = {') || t.includes('var CONFIG = {') || t.includes('let CONFIG = {') || t.includes('CONFIG = {')) {
        console.log(`L${i + 1} [CONFIG_DEF]: ${t}`);
        matches++;
    }
    // Find maxOdds property definition
    if (t.startsWith('maxOdds:')) {
        console.log(`L${i + 1} [MAXODDS]: ${t}`);
        matches++;
    }
    // Find config version
    if (t.startsWith('const CONFIG_VERSION =') || t.startsWith('CONFIG_VERSION =')) {
        console.log(`L${i + 1} [VERSION]: ${t}`);
        matches++;
    }
    // Find active preset
    if (t.startsWith('ACTIVE_PRESET:')) {
        console.log(`L${i + 1} [PRESET]: ${t}`);
        matches++;
    }
    // Find Genesis Supremacy references
    if (t.includes('GENESIS') && (t.includes('Supremacy') || t.includes('weight'))) {
        console.log(`L${i + 1} [GENESIS]: ${t}`);
        matches++;
    }
});
console.log('--- SEARCH ENDED ---');
