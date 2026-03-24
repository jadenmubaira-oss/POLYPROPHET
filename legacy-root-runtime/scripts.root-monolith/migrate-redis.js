#!/usr/bin/env node
/**
 * POLYPROPHET Redis Migration Script
 * 
 * Exports data from Render Redis and imports to Upstash Redis
 * 
 * Usage:
 *   1. Export from Render:  node scripts/migrate-redis.js export
 *   2. Import to Upstash:   node scripts/migrate-redis.js import
 * 
 * Environment Variables:
 *   SOURCE_REDIS_URL - Render Redis URL (for export)
 *   TARGET_REDIS_URL - Upstash Redis URL (for import)
 */

const Redis = require('ioredis');
const fs = require('fs');
const path = require('path');

const EXPORT_FILE = path.join(__dirname, '..', 'redis-export.json');

// 🏆 v122: All Redis keys for complete backup/restore (nuclear option recovery)
const POLYPROPHET_KEYS = [
    'deity:settings',
    'deity:state',
    'deity:trades',
    'deity:trades:hash',
    'deity:positions',
    'deity:calibration:*',
    'deity:brains:*',
    'deity:collector:*',
    'deity:enhanced-dataset:*',
    'deity:longterm-dataset:*',
    'modelAccuracy:*',
    'calibrationBuckets:*',
    'polyprophet:trades:*',
    'polyprophet:manualJourney:*',
    'polyprophet:manualTradeIdempotency:*',
    'telegramHistory',
    'patterns:*',
    'polyprophet:collector:*'
];

async function exportFromRedis() {
    const sourceUrl = process.env.SOURCE_REDIS_URL || process.env.REDIS_URL;
    
    if (!sourceUrl) {
        console.error('❌ SOURCE_REDIS_URL or REDIS_URL not set');
        console.log('   Set it to your Render Redis URL');
        process.exit(1);
    }

    console.log('📤 Connecting to source Redis...');
    const redis = new Redis(sourceUrl, {
        maxRetriesPerRequest: 3,
        retryDelayOnFailover: 1000
    });

    try {
        await redis.ping();
        console.log('✅ Connected to source Redis');

        const exportData = {
            exportedAt: new Date().toISOString(),
            version: 'polyprophet-v100',
            keys: {}
        };

        // Get all keys matching our patterns
        const allKeys = new Set();
        for (const pattern of POLYPROPHET_KEYS) {
            const keys = await redis.keys(pattern);
            keys.forEach(k => allKeys.add(k));
        }

        // Also get any keys starting with 'deity:'
        const deityKeys = await redis.keys('deity:*');
        deityKeys.forEach(k => allKeys.add(k));

        console.log(`📊 Found ${allKeys.size} keys to export`);

        for (const key of allKeys) {
            try {
                const type = await redis.type(key);
                let value;

                switch (type) {
                    case 'string':
                        value = { type: 'string', data: await redis.get(key) };
                        break;
                    case 'hash':
                        value = { type: 'hash', data: await redis.hgetall(key) };
                        break;
                    case 'list':
                        value = { type: 'list', data: await redis.lrange(key, 0, -1) };
                        break;
                    case 'set':
                        value = { type: 'set', data: await redis.smembers(key) };
                        break;
                    case 'zset':
                        value = { type: 'zset', data: await redis.zrange(key, 0, -1, 'WITHSCORES') };
                        break;
                    default:
                        console.log(`  ⚠️ Skipping unknown type '${type}' for key '${key}'`);
                        continue;
                }

                exportData.keys[key] = value;
                console.log(`  ✅ Exported: ${key} (${type})`);
            } catch (e) {
                console.log(`  ⚠️ Error exporting ${key}: ${e.message}`);
            }
        }

        // Write to file
        fs.writeFileSync(EXPORT_FILE, JSON.stringify(exportData, null, 2));
        console.log(`\n✅ Exported ${Object.keys(exportData.keys).length} keys to ${EXPORT_FILE}`);
        console.log(`   File size: ${(fs.statSync(EXPORT_FILE).size / 1024).toFixed(2)} KB`);

    } catch (e) {
        console.error('❌ Export failed:', e.message);
        process.exit(1);
    } finally {
        await redis.quit();
    }
}

async function importToRedis() {
    const targetUrl = process.env.TARGET_REDIS_URL;
    
    if (!targetUrl) {
        console.error('❌ TARGET_REDIS_URL not set');
        console.log('   Set it to your Upstash Redis URL');
        process.exit(1);
    }

    if (!fs.existsSync(EXPORT_FILE)) {
        console.error(`❌ Export file not found: ${EXPORT_FILE}`);
        console.log('   Run "node scripts/migrate-redis.js export" first');
        process.exit(1);
    }

    console.log('📥 Loading export file...');
    const exportData = JSON.parse(fs.readFileSync(EXPORT_FILE, 'utf8'));
    console.log(`   Exported at: ${exportData.exportedAt}`);
    console.log(`   Keys to import: ${Object.keys(exportData.keys).length}`);

    console.log('\n📥 Connecting to target Redis (Upstash)...');
    const redis = new Redis(targetUrl, {
        maxRetriesPerRequest: 3,
        retryDelayOnFailover: 1000,
        tls: targetUrl.includes('upstash.io') ? {} : undefined
    });

    try {
        await redis.ping();
        console.log('✅ Connected to target Redis');

        let imported = 0;
        let errors = 0;

        for (const [key, value] of Object.entries(exportData.keys)) {
            try {
                switch (value.type) {
                    case 'string':
                        await redis.set(key, value.data);
                        break;
                    case 'hash':
                        if (Object.keys(value.data).length > 0) {
                            await redis.del(key);
                            await redis.hset(key, value.data);
                        }
                        break;
                    case 'list':
                        if (value.data.length > 0) {
                            await redis.del(key);
                            await redis.rpush(key, ...value.data);
                        }
                        break;
                    case 'set':
                        if (value.data.length > 0) {
                            await redis.del(key);
                            await redis.sadd(key, ...value.data);
                        }
                        break;
                    case 'zset':
                        if (value.data.length > 0) {
                            await redis.del(key);
                            // WITHSCORES returns [member, score, member, score, ...]
                            const pairs = [];
                            for (let i = 0; i < value.data.length; i += 2) {
                                pairs.push(parseFloat(value.data[i + 1]), value.data[i]);
                            }
                            if (pairs.length > 0) {
                                await redis.zadd(key, ...pairs);
                            }
                        }
                        break;
                }
                imported++;
                console.log(`  ✅ Imported: ${key}`);
            } catch (e) {
                errors++;
                console.log(`  ❌ Error importing ${key}: ${e.message}`);
            }
        }

        console.log(`\n✅ Import complete: ${imported} keys imported, ${errors} errors`);

    } catch (e) {
        console.error('❌ Import failed:', e.message);
        process.exit(1);
    } finally {
        await redis.quit();
    }
}

// Main
const command = process.argv[2];

switch (command) {
    case 'export':
    case 'backup':
        exportFromRedis().then(() => {
            console.log('\n✅ Backup complete!');
            console.log(`📦 File: ${EXPORT_FILE}`);
            console.log(`💾 Save this file to USB/external drive for nuclear option recovery.`);
        }).catch(e => {
            console.error('❌ Backup failed:', e.message);
            process.exit(1);
        });
        break;
    case 'import':
    case 'restore':
        importToRedis().then(() => {
            console.log('\n✅ Restore complete!');
            console.log('🔄 Restart server to load restored data.');
        }).catch(e => {
            console.error('❌ Restore failed:', e.message);
            process.exit(1);
        });
        break;
    default:
        console.log('POLYPROPHET Redis Backup/Restore Tool');
        console.log('');
        console.log('Usage:');
        console.log('  node scripts/migrate-redis.js export|backup   Export all Redis data to redis-export.json');
        console.log('  node scripts/migrate-redis.js import|restore  Import redis-export.json to Redis');
        console.log('');
        console.log('Environment Variables:');
        console.log('  SOURCE_REDIS_URL   Source Redis - used for export/backup');
        console.log('  TARGET_REDIS_URL   Target Redis - used for import/restore');
        console.log('  REDIS_URL          Fallback for SOURCE_REDIS_URL');
        process.exit(1);
}
