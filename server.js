/**
 * POLYPROPHET ROOT ENTRY POINT
 * 
 * This file redirects to the actual server in POLYPROPHET-FINAL/
 * Required because Render is configured to run from root directory.
 */

// Change working directory to POLYPROPHET-FINAL and run from there
const path = require('path');
process.chdir(path.join(__dirname, 'POLYPROPHET-FINAL'));

// Now require the actual server
require('./server.js');

