/**
 * POLYPROPHET ROOT ENTRY POINT
 * 
 * This file redirects to the actual server in POLYPROPHET-FINAL/
 * Required because Render is configured to run from root directory.
 */

const path = require('path');
const { spawn } = require('child_process');

// Get the path to POLYPROPHET-FINAL
const finalDir = path.join(__dirname, 'POLYPROPHET-FINAL');

console.log('🚀 Starting POLYPROPHET from:', finalDir);

// Spawn node in the correct directory
const child = spawn('node', ['server.js'], {
    cwd: finalDir,
    stdio: 'inherit',
    env: process.env
});

child.on('error', (err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
});

child.on('exit', (code) => {
    process.exit(code || 0);
});

