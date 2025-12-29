/**
 * 🔮 POLYPROPHET OMEGA: MOBILE APP FOR VIBECODE
 * 
 * iPhone 12 mini optimized
 * Background operation with WebSocket
 * Push notifications for trades
 * Dark theme with purple accents
 */

// This is a Vibecode-compatible JavaScript file
// Vibecode runs JavaScript in a mobile environment

const SERVER_URL = localStorage.getItem('polyprophet_server_url') || 'https://your-server.onrender.com';
let ws = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;

// ==================== STATE ====================
let appState = {
    connected: false,
    balance: 0,
    todayPnL: 0,
    positions: [],
    trades: [],
    predictions: {},
    lastUpdate: null
};

// ==================== WEBSOCKET CONNECTION ====================
function connectWebSocket() {
    if (ws && ws.readyState === WebSocket.OPEN) return;
    
    const wsUrl = SERVER_URL.replace('https://', 'wss://').replace('http://', 'ws://') + '/socket.io/?EIO=4&transport=websocket';
    
    try {
        // For Vibecode, use native WebSocket
        ws = new WebSocket(wsUrl);
        
        ws.onopen = () => {
            console.log('✅ WebSocket Connected');
            appState.connected = true;
            reconnectAttempts = 0;
            updateUI();
            requestNotificationPermission();
        };
        
        ws.onmessage = (event) => {
            try {
                // Socket.IO format handling
                const data = JSON.parse(event.data);
                if (data.type === 'state_update') {
                    handleStateUpdate(data);
                }
            } catch (e) {
                // Try direct JSON
                try {
                    const data = JSON.parse(event.data);
                    handleStateUpdate(data);
                } catch (e2) {
                    console.error('Failed to parse WebSocket message:', e2);
                }
            }
        };
        
        ws.onerror = (error) => {
            console.error('WebSocket Error:', error);
            appState.connected = false;
            updateUI();
        };
        
        ws.onclose = () => {
            console.log('WebSocket Closed');
            appState.connected = false;
            updateUI();
            
            // Auto-reconnect
            if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                reconnectAttempts++;
                setTimeout(() => {
                    console.log(`Reconnecting... (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
                    connectWebSocket();
                }, 3000 * reconnectAttempts);
            }
        };
    } catch (e) {
        console.error('WebSocket connection failed:', e);
        // Fallback to polling
        startPolling();
    }
}

// Fallback polling if WebSocket fails
function startPolling() {
    setInterval(async () => {
        try {
            const response = await fetch(`${SERVER_URL}/api/state`);
            const data = await response.json();
            handleStateUpdate(data);
        } catch (e) {
            console.error('Polling failed:', e);
        }
    }, 5000);
}

// ==================== STATE HANDLING ====================
function handleStateUpdate(data) {
    if (data._trading) {
        appState.balance = data._trading.balance || 0;
        appState.todayPnL = data._trading.todayPnL || 0;
        appState.positions = Object.values(data._trading.positions || {});
        appState.trades = data._trading.tradeHistory || [];
    }
    
    // Extract predictions
    appState.predictions = {};
    ['BTC', 'ETH', 'SOL', 'XRP'].forEach(asset => {
        if (data[asset]) {
            appState.predictions[asset] = data[asset];
        }
    });
    
    appState.lastUpdate = new Date();
    updateUI();
    checkForNewTrades(data);
}

let lastTradeCount = 0;
function checkForNewTrades(data) {
    const currentTradeCount = (data._trading?.tradeHistory || []).length;
    if (currentTradeCount > lastTradeCount) {
        // New trade detected
        const newTrades = data._trading.tradeHistory.slice(lastTradeCount);
        newTrades.forEach(trade => {
            sendNotification(
                `📈 New Trade: ${trade.asset} ${trade.side}`,
                `Entry: ${(trade.entry * 100).toFixed(1)}¢ | Size: $${trade.size?.toFixed(2) || 'N/A'}`
            );
        });
        lastTradeCount = currentTradeCount;
    }
}

// ==================== NOTIFICATIONS ====================
function requestNotificationPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
    }
}

function sendNotification(title, body) {
    if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(title, {
            body: body,
            icon: '/icon.png',
            badge: '/badge.png',
            tag: 'polyprophet-trade',
            requireInteraction: false
        });
    }
    
    // Haptic feedback (if available in Vibecode)
    if (navigator.vibrate) {
        navigator.vibrate(200);
    }
}

// ==================== UI RENDERING ====================
function updateUI() {
    // Update connection status
    const statusEl = document.getElementById('connection-status');
    if (statusEl) {
        statusEl.textContent = appState.connected ? '🟢 Connected' : '🔴 Disconnected';
        statusEl.style.color = appState.connected ? '#00ff88' : '#ff4466';
    }
    
    // Update balance
    const balanceEl = document.getElementById('balance');
    if (balanceEl) {
        balanceEl.textContent = `$${appState.balance.toFixed(2)}`;
    }
    
    // Update P&L
    const pnlEl = document.getElementById('pnl');
    if (pnlEl) {
        pnlEl.textContent = `${appState.todayPnL >= 0 ? '+' : ''}$${appState.todayPnL.toFixed(2)}`;
        pnlEl.style.color = appState.todayPnL >= 0 ? '#00ff88' : '#ff4466';
    }
    
    // Update predictions
    renderPredictions();
    
    // Update trades
    renderTrades();
    
    // Update positions
    renderPositions();
}

function renderPredictions() {
    const container = document.getElementById('predictions-container');
    if (!container) return;
    
    let html = '';
    ['BTC', 'ETH', 'SOL', 'XRP'].forEach(asset => {
        const pred = appState.predictions[asset];
        if (!pred) {
            html += `<div class="prediction-card">
                <div class="asset-name">${asset}</div>
                <div class="prediction-value WAIT">WAITING</div>
            </div>`;
            return;
        }
        
        const conf = (pred.confidence * 100).toFixed(0);
        const confClass = conf >= 70 ? 'high' : conf >= 50 ? 'medium' : 'low';
        const predClass = pred.prediction || 'WAIT';
        
        html += `<div class="prediction-card ${pred.locked ? 'locked' : ''}">
            <div class="asset-name">${asset}</div>
            <div class="prediction-value ${predClass}">${pred.prediction || 'WAIT'}</div>
            <div class="confidence-bar">
                <div class="confidence-fill ${confClass}" style="width: ${conf}%"></div>
            </div>
            <div class="confidence-text">${conf}% Confidence</div>
            <div class="tier-badge ${pred.tier || 'NONE'}">${pred.tier || 'NONE'}</div>
            ${pred.market ? `<div class="market-odds">YES: ${(pred.market.yesPrice * 100).toFixed(1)}¢ | NO: ${(pred.market.noPrice * 100).toFixed(1)}¢</div>` : ''}
        </div>`;
    });
    
    container.innerHTML = html;
}

function renderTrades() {
    const container = document.getElementById('trades-container');
    if (!container) return;
    
    const recentTrades = appState.trades.slice(-10).reverse();
    
    if (recentTrades.length === 0) {
        container.innerHTML = '<div class="empty-state">No trades yet</div>';
        return;
    }
    
    let html = '';
    recentTrades.forEach(trade => {
        const pnl = trade.pnl || 0;
        const pnlPercent = trade.pnlPercent || 0;
        const isWin = pnl >= 0;
        
        html += `<div class="trade-card ${isWin ? 'win' : 'loss'}">
            <div class="trade-header">
                <span class="trade-asset">${trade.asset}</span>
                <span class="trade-side ${trade.side}">${trade.side}</span>
            </div>
            <div class="trade-details">
                <div>Entry: ${(trade.entry * 100).toFixed(1)}¢</div>
                ${trade.exit ? `<div>Exit: ${(trade.exit * 100).toFixed(1)}¢</div>` : ''}
                <div>Size: $${trade.size?.toFixed(2) || 'N/A'}</div>
                ${pnl !== undefined ? `<div class="trade-pnl ${isWin ? 'positive' : 'negative'}">
                    P/L: ${isWin ? '+' : ''}$${pnl.toFixed(2)} (${isWin ? '+' : ''}${pnlPercent.toFixed(1)}%)
                </div>` : ''}
            </div>
            ${trade.reason ? `<div class="trade-reason">${trade.reason}</div>` : ''}
            <div class="trade-time">${new Date(trade.time).toLocaleTimeString()}</div>
        </div>`;
    });
    
    container.innerHTML = html;
}

function renderPositions() {
    const container = document.getElementById('positions-container');
    if (!container) return;
    
    const openPositions = appState.positions.filter(p => p.status === 'OPEN');
    
    if (openPositions.length === 0) {
        container.innerHTML = '<div class="empty-state">No open positions</div>';
        return;
    }
    
    let html = '';
    openPositions.forEach(pos => {
        html += `<div class="position-card">
            <div class="position-header">
                <span class="position-asset">${pos.asset}</span>
                <span class="position-side ${pos.side}">${pos.side}</span>
            </div>
            <div class="position-details">
                <div>Entry: ${(pos.entry * 100).toFixed(1)}¢</div>
                <div>Size: $${pos.size?.toFixed(2) || 'N/A'}</div>
                <div>State: ${pos.state || 'N/A'}</div>
            </div>
        </div>`;
    });
    
    container.innerHTML = html;
}

// ==================== SETTINGS ====================
function openSettings() {
    const url = prompt('Enter your Render server URL:', SERVER_URL);
    if (url) {
        localStorage.setItem('polyprophet_server_url', url);
        location.reload();
    }
}

// ==================== INITIALIZATION ====================
document.addEventListener('DOMContentLoaded', () => {
    console.log('🔮 PolyProphet Mobile App Starting...');
    connectWebSocket();
    
    // Update UI every second
    setInterval(updateUI, 1000);
    
    // Reconnect check every 30 seconds
    setInterval(() => {
        if (!appState.connected && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            connectWebSocket();
        }
    }, 30000);
});

// Background operation (for Vibecode)
if (typeof window !== 'undefined') {
    // Keep connection alive when app is in background
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && !appState.connected) {
            connectWebSocket();
        }
    });
    
    // Handle app resume
    window.addEventListener('focus', () => {
        if (!appState.connected) {
            connectWebSocket();
        }
    });
}

// Export for Vibecode
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { connectWebSocket, updateUI, appState };
}

