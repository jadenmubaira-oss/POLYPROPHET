# 🚀 RENDER.COM DEPLOYMENT GUIDE

## Why Render?
- ✅ Free tier available
- ✅ Built-in Redis addon
- ✅ Auto-deploy from Git
- ✅ Easy environment variables
- ✅ 24/7 uptime

## Step-by-Step Deployment

### 1. Create Render Account
1. Go to https://render.com
2. Sign up (free)
3. Verify email

### 2. Create Redis Instance
1. Click "New +" → "Redis"
2. Name: `polymarket-oracle-redis`
3. Plan: **Free** (25MB - enough for patterns)
4. Region: Choose closest to you
5. Click "Create Redis"
6. **COPY** the "Internal Redis URL" (starts with `redis://`)

### 3. Create Web Service
1. Click "New +" → "Web Service"
2. Choose "Build and deploy from a Git repository"
3. Connect your GitHub/GitLab (or use "Public Git repository")

### 4. Configure Service
```
Name: polymarket-oracle
Region: Same as Redis
Branch: main
Runtime: Node
Build Command: npm install
Start Command: node server.js
```

### 5. Set Environment Variables
Click "Environment" tab, add:
```
REDIS_URL = [paste Internal Redis URL from step 2]
AUTH_USERNAME = admin
AUTH_PASSWORD = [your secure password]
PORT = 3000
```

### 6. Deploy
1. Click "Create Web Service"
2. Wait 2-3 minutes for build
3. Check logs for:
   ```
   ✅ Redis Connected
   ✅ Connected to Polymarket WS
   ⚡ SUPREME DEITY SERVER ONLINE
   ```

### 7. Access Your Oracle
```
URL: https://polymarket-oracle.onrender.com
API: https://polymarket-oracle.onrender.com/api/state
```

## Free Tier Limitations
- **Spins down after 15min inactivity**
- **Solution**: Use UptimeRobot (free) to ping every 5 minutes
  - Go to https://uptimerobot.com
  - Add monitor: `https://your-app.onrender.com/api/state`
  - Interval: 5 minutes

## Upgrading to Paid ($7/month)
- No spin-down
- Better performance
- Recommended for serious use

## Troubleshooting

### "Application failed to respond"
- Check logs for errors
- Verify REDIS_URL is correct
- Wait 30 seconds for WebSocket connection

### "Redis connection failed"
- Verify Redis instance is running
- Check REDIS_URL format: `redis://default:password@host:port`
- Ensure Redis and Web Service in same region

### "No predictions"
- Wait 10 minutes for price history
- Check logs for WebSocket connection
- Verify Polymarket API is accessible

## Monitoring
```bash
# View logs
Click "Logs" tab in Render dashboard

# Check predictions
curl https://your-app.onrender.com/api/state

# Check health
curl https://your-app.onrender.com/
```

## Cost Estimate
- Free tier: $0/month (with spin-down)
- Paid tier: $7/month (no spin-down)
- Redis: Free (25MB) or $10/month (100MB)

**Recommended**: Start free, upgrade after testing
