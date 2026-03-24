const fs = require('fs');

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: node scripts/_scan_epoch_range.js <path-to-json>');
  process.exit(1);
}

const stream = fs.createReadStream(filePath, { encoding: 'utf8' });

let min = Infinity;
let max = -Infinity;
let matches = 0;
let carry = '';

const re = /"cycleStartEpochSec"\s*:\s*(\d+)/g;

stream.on('data', (chunk) => {
  const text = carry + chunk;
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text))) {
    const v = Number(m[1]);
    if (Number.isFinite(v)) {
      if (v < min) min = v;
      if (v > max) max = v;
      matches++;
    }
  }
  carry = text.slice(-200);
});

stream.on('end', () => {
  const out = {
    file: filePath,
    matches,
    minEpoch: Number.isFinite(min) ? min : null,
    maxEpoch: Number.isFinite(max) ? max : null,
    minIso: Number.isFinite(min) ? new Date(min * 1000).toISOString() : null,
    maxIso: Number.isFinite(max) ? new Date(max * 1000).toISOString() : null,
  };
  console.log(JSON.stringify(out, null, 2));
});

stream.on('error', (e) => {
  console.error('ERR', e && e.message ? e.message : String(e));
  process.exit(1);
});
