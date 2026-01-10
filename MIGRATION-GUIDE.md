# POLYPROPHET Migration Guide: Render → Fly.io (Netherlands)

## Why We're Moving
Your current Render deployment is in **Oregon, US** (IP: `74.220.48.241`) which is **geo-blocked** by Polymarket. Moving to **Fly.io Amsterdam (Netherlands)** will resolve this.

---

## Prerequisites
- Node.js installed locally
- Git installed
- A credit/debit card (Fly.io requires this but won't charge for free tier)

---

## STEP 1: Create Upstash Redis (Free Tier)

Upstash provides free Redis that works globally. This keeps your trading history and settings.

1. Go to **https://upstash.com** and sign up (use GitHub/Google)
2. Click **"Create Database"**
3. Configure:
   - **Name**: `polyprophet`
   - **Region**: `eu-west-1` (Ireland) - closest to Netherlands
   - **Type**: Regional
4. Click **Create**
5. On the database page, copy the **Redis URL** (looks like `rediss://default:xxx@eu1-xxx.upstash.io:6379`)

**Save this URL - you'll need it!**

---

## STEP 2: Export Your Render Redis Data

Run these commands in your local project folder:

```powershell
# Navigate to project
cd C:\Users\voide\Downloads\POLYPROPHET-main\POLYPROPHET-main

# Set your Render Redis URL (the internal one won't work externally)
# You need to get the EXTERNAL Redis URL from Render Dashboard
# Go to Render → Your Redis → Info → External URL
$env:SOURCE_REDIS_URL="redis://red-d4k427muk2gs73fk8icg:6379"

# Run the export
node scripts/migrate-redis.js export
```

**Note**: If the Render Redis is internal-only, you may need to:
1. Go to Render Dashboard → Redis → Settings
2. Enable "External Access" temporarily
3. Use the external URL (with password)

The export creates `redis-export.json` in your project folder.

---

## STEP 3: Import Data to Upstash

```powershell
# Set your Upstash Redis URL (the one you copied in Step 1)
$env:TARGET_REDIS_URL="rediss://default:YOUR_PASSWORD@eu1-YOUR-ID.upstash.io:6379"

# Run the import
node scripts/migrate-redis.js import
```

---

## STEP 4: Install Fly.io CLI

```powershell
# Install flyctl (Windows PowerShell)
powershell -Command "iwr https://fly.io/install.ps1 -useb | iex"

# Or using npm
npm install -g flyctl

# Login to Fly.io
flyctl auth login
```

This opens a browser - sign up/login with GitHub or email.

---

## STEP 5: Create Fly.io App

```powershell
# Navigate to project
cd C:\Users\voide\Downloads\POLYPROPHET-main\POLYPROPHET-main

# Create the app (this uses the fly.toml we created)
flyctl launch --no-deploy

# When prompted:
# - App name: polyprophet (or your preferred name)
# - Region: Choose "ams" (Amsterdam, Netherlands)
# - Don't set up Postgres
# - Don't set up Redis (we're using Upstash)
```

---

## STEP 6: Set Environment Variables (Secrets)

Set ALL your environment variables as Fly.io secrets:

```powershell
# Core secrets
flyctl secrets set API_KEY="1234567890"
flyctl secrets set AUTH_USERNAME="bandito"
flyctl secrets set AUTH_PASSWORD="bandito"

# Polymarket credentials
flyctl secrets set POLYMARKET_API_KEY="ec05b79f-5c60-baef-c45f-c7cb131eff36"
flyctl secrets set POLYMARKET_SECRET="6hC-wPEJ8_I0AICdaN5GZC3ZjYPWsLuSPizTgIVYoS0="
flyctl secrets set POLYMARKET_PASSPHRASE="581466eda27ddf6030baee95a2b36f430542172d86cd5220c5e0e05ad623e052"
flyctl secrets set POLYMARKET_PRIVATE_KEY="0x7500b5809170c84aaa5329cba59454c9883a9165e42e36f135eae3fcf7dbede7"

# Redis (Upstash URL from Step 1)
flyctl secrets set REDIS_URL="rediss://default:YOUR_PASSWORD@eu1-YOUR-ID.upstash.io:6379"

# Trading mode
flyctl secrets set TRADE_MODE="LIVE"
flyctl secrets set AUTO_BANKROLL_MODE="SPRINT"

# Remove proxy (not needed in Netherlands)
# Don't set PROXY_URL - direct connection works!
```

---

## STEP 7: Deploy to Fly.io

```powershell
# Deploy the app
flyctl deploy

# This will:
# - Build a Docker image
# - Push to Fly.io registry
# - Deploy to Amsterdam
# - Start the app
```

Wait for deployment to complete (2-5 minutes).

---

## STEP 8: Verify Deployment

```powershell
# Check app status
flyctl status

# View logs
flyctl logs

# Get your app URL
flyctl info
```

Your app URL will be: `https://polyprophet.fly.dev` (or your chosen name)

---

## STEP 9: Test Geo Unblocked

Open in browser:
```
https://YOUR-APP-NAME.fly.dev/api/verify?apiKey=1234567890&deep=1
```

**Look for:**
- `"Polymarket geoblock endpoint (deep)": "passed": true, "details": "blocked=false; country=NL"`

If you see `blocked=false` and `country=NL` — **SUCCESS! You're unblocked!**

---

## STEP 10: Disable Render (Optional)

Once Fly.io is working:
1. Go to Render Dashboard
2. Suspend or delete the web service
3. You can keep Redis running temporarily as backup

---

## Troubleshooting

### "App not starting"
```powershell
flyctl logs --app polyprophet
```
Check for errors in the logs.

### "Redis connection failed"
Make sure your Upstash URL:
- Starts with `rediss://` (with double s for TLS)
- Has the correct password
- Uses port 6379

### "Still geo-blocked"
Verify the app is running in Amsterdam:
```powershell
flyctl status
```
Should show `Region: ams`

### "Out of memory"
Upgrade VM size in fly.toml:
```toml
[[vm]]
  memory_mb = 1024
```

---

## Quick Reference

| Service | URL |
|---------|-----|
| Fly.io Dashboard | https://fly.io/dashboard |
| Upstash Console | https://console.upstash.com |
| Your App | https://YOUR-APP-NAME.fly.dev |
| Health Check | https://YOUR-APP-NAME.fly.dev/api/health |
| Deep Verify | https://YOUR-APP-NAME.fly.dev/api/verify?deep=1&apiKey=YOUR_KEY |

---

## Cost Summary

| Service | Cost |
|---------|------|
| Fly.io (free tier) | $0/month (up to 3 VMs) |
| Upstash Redis (free tier) | $0/month (10k commands/day) |
| **Total** | **$0/month** |

---

## What You Keep

✅ All trading history  
✅ Brain calibration data  
✅ Settings and configuration  
✅ Wallet connection (same private key)  
✅ Polymarket positions  
