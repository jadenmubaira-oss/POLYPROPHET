# 🚂 RAILWAY.APP DEPLOYMENT GUIDE

## Why Railway?
- ✅ $5 free credit (no card required)
- ✅ Built-in Redis
- ✅ Simple deployment
- ✅ Great for testing

## Step-by-Step Deployment

### 1. Create Railway Account
1. Go to https://railway.app
2. Sign up with GitHub
3. Get $5 free credit

### 2. Create New Project
1. Click "New Project"
2. Select "Deploy from GitHub repo" OR "Empty Project"

### 3. Add Redis
1. Click "New" → "Database" → "Add Redis"
2. Railway auto-creates Redis instance
3. Note: Connection details auto-populate

### 4. Add Web Service
1. Click "New" → "GitHub Repo" (or "Empty Service")
2. If empty: Upload server.js and package.json
3. Railway auto-detects Node.js

### 5. Configure Environment Variables
Click service → "Variables" tab:
```
REDIS_URL = ${{Redis.REDIS_URL}}  # Auto-filled
AUTH_USERNAME = admin
AUTH_PASSWORD = your_secure_password
PORT = 3000
```

### 6. Deploy
1. Click "Deploy"
2. Wait 2-3 minutes
3. Check logs for success messages

### 7. Get Public URL
1. Click service → "Settings"
2. Scroll to "Networking"
3. Click "Generate Domain"
4. Copy URL: `https://your-app.up.railway.app`

## Cost Management

### Free Credit ($5)
- Lasts ~1 month with minimal usage
- Monitor in dashboard

### After Free Credit
- Pay-as-you-go: ~$5-10/month
- Can pause services when not in use

## Troubleshooting

### "Build failed"
```bash
# Check package.json exists
# Verify Node.js version compatibility
# Check build logs for specific error
```

### "Redis connection failed"
```bash
# Verify Redis service is running
# Check REDIS_URL variable is set
# Restart both services
```

### "Service crashed"
```bash
# Check logs for error
# Verify all dependencies installed
# Check memory usage (upgrade if needed)
```

## Monitoring
```bash
# View logs
Click service → "Logs" tab

# Check metrics
Click service → "Metrics" tab

# Test API
curl https://your-app.up.railway.app/api/state
```

## Advantages vs Render
- ✅ No spin-down on free tier
- ✅ Faster deployments
- ✅ Better logging
- ❌ Free credit runs out

## Recommended Usage
- **Testing**: Use Railway (free credit)
- **Production**: Use Render paid tier (more stable)
