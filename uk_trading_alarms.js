// 🇬🇧 UK TRADING ALARM SYSTEM
// Pre-warning notifications for premium trading hours
// Converts UTC to UK time (accounts for BST/GMT automatically)

const PREMIUM_HOURS = {
    // BTC DOWN → ETH DOWN conditions
    2: { condition: 'BTC_DOWN', trade: 'ETH_DOWN', wr: '92.9%' },
    14: { condition: 'BTC_DOWN', trade: 'ETH_DOWN', wr: '96.1%' },
    // BTC UP → ETH UP conditions
    3: { condition: 'BTC_UP', trade: 'ETH_UP', wr: '93.1%' },
    4: { condition: 'BTC_UP', trade: 'ETH_UP', wr: '91.5%' },
    8: { condition: 'BTC_UP', trade: 'ETH_UP', wr: '91.7%' },
};

function getUKTime(utcDate) {
    // JavaScript automatically handles BST/GMT conversion for UK
    return new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/London',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    }).format(utcDate);
}

function getUKHour(utcHour) {
    // Create a date in the current day at the given UTC hour
    const now = new Date();
    const testDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), utcHour, 0, 0));
    const ukTime = getUKTime(testDate);
    return parseInt(ukTime.split(':')[0]);
}

// Check if UK is currently in BST or GMT
function isUKInBST() {
    const jan = new Date(Date.UTC(new Date().getFullYear(), 0, 1));
    const jul = new Date(Date.UTC(new Date().getFullYear(), 6, 1));
    const janOffset = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', timeZoneName: 'short' }).format(jan);
    const julOffset = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', timeZoneName: 'short' }).format(jul);
    const now = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', timeZoneName: 'short' }).format(new Date());
    return now.includes('BST');
}

console.log('🇬🇧 UK TRADING HOURS (Premium Strategy)');
console.log('========================================\n');

const isBST = isUKInBST();
console.log(`Current timezone: ${isBST ? 'BST (UTC+1)' : 'GMT (UTC+0)'}\n`);

console.log('PREMIUM TRADING HOURS:\n');
console.log('UTC Hour | UK Time | Condition | Trade | Win Rate');
console.log('---------|---------|-----------|-------|----------');

Object.entries(PREMIUM_HOURS)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .forEach(([utcHour, info]) => {
        const ukHour = getUKHour(Number(utcHour));
        const ukTime = `${ukHour.toString().padStart(2, '0')}:00`;
        console.log(`   ${utcHour.padStart(2)}   |  ${ukTime}  | ${info.condition.padEnd(9)} | ${info.trade.padEnd(8)} | ${info.wr}`);
    });

console.log('\n📱 SET THESE ALARMS (UK TIME):');
console.log('');

// Generate alarm schedule
const alarms = Object.entries(PREMIUM_HOURS)
    .map(([utcHour, info]) => ({
        utc: Number(utcHour),
        uk: getUKHour(Number(utcHour)),
        ...info
    }))
    .sort((a, b) => a.uk - b.uk);

alarms.forEach(alarm => {
    const formatted = `${alarm.uk.toString().padStart(2, '0')}:00`;
    const prewarn = `${alarm.uk.toString().padStart(2, '0')}:05`;  // 5 min into cycle for setup
    console.log(`⏰ ${formatted} → Watch for ${alarm.condition.replace('_', ' ')}, trade ${alarm.trade.replace('_', ' ')}`);
});

console.log('\n📋 EXECUTION PROTOCOL:');
console.log('');
console.log('1. Alarm rings at premium hour (e.g., 02:00 UK)');
console.log('2. Open Polymarket and check BTC market');
console.log('3. Wait 2-5 mins to confirm BTC direction');
console.log('4. If BTC matches expected (e.g., DOWN at 02:00):');
console.log('   → Buy ETH in same direction at 40-45¢');
console.log('5. Hold until cycle resolution (15 mins from xx:00)');
console.log('6. Collect payout!');
console.log('');

console.log('⚠️ IMPORTANT:');
console.log('- Each cycle starts at xx:00 or xx:15 (every 15 mins)');
console.log('- Trade in FIRST 5 mins for best results');
console.log('- Skip if BTC direction is unclear');
console.log('- Sizing: 20% (100% survival) or 30% (99.2% survival)');
console.log('');

// Show next trading window
console.log('=== NEXT TRADING WINDOW ===\n');

const now = new Date();
const currentUTCHour = now.getUTCHours();
const currentUTCMin = now.getUTCMinutes();

let nextWindow = null;
for (const alarm of alarms.sort((a, b) => a.utc - b.utc)) {
    if (alarm.utc > currentUTCHour || (alarm.utc === currentUTCHour && currentUTCMin < 10)) {
        nextWindow = alarm;
        break;
    }
}
if (!nextWindow) {
    nextWindow = alarms.sort((a, b) => a.utc - b.utc)[0];  // Tomorrow's first
    nextWindow.tomorrow = true;
}

const nextDate = new Date(now);
if (nextWindow.tomorrow) nextDate.setDate(nextDate.getDate() + 1);
nextDate.setUTCHours(nextWindow.utc, 0, 0, 0);

console.log(`Next: ${getUKTime(nextDate)} UK time`);
console.log(`Condition: ${nextWindow.condition.replace('_', ' ')} → ${nextWindow.trade.replace('_', ' ')}`);
console.log(`Win Rate: ${nextWindow.wr}`);
console.log(`Time until: ${Math.floor((nextDate - now) / 60000)} minutes${nextWindow.tomorrow ? ' (tomorrow)' : ''}`);
console.log('');
console.log('========================================');
