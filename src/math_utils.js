/**
 * OMEGA V2: MATH UTILITIES
 * 
 * Logic: Precision character-by-character restoration of the Prophet library.
 */

class KalmanFilter {
    constructor(q = 0.0001, r = 0.001) {
        this.q = q; // Process noise
        this.r = r; // Measurement noise
        this.x = null; // Estimated signal
        this.p = 1.0; // Estimation error
    }

    filter(measurement) {
        if (this.x === null) {
            this.x = measurement;
            return measurement;
        }

        this.p = this.p + this.q;
        const k = this.p / (this.p + this.r);
        this.x = this.x + k * (measurement - this.x);
        this.p = (1 - k) * this.p;
        return this.x;
    }
}

const MathLib = {
    average: (data) => data.reduce((a, b) => a + b, 0) / data.length,

    stdDev: (data) => {
        const avg = MathLib.average(data);
        return Math.sqrt(data.map(x => Math.pow(x - avg, 2)).reduce((a, b) => a + b, 0) / data.length);
    },

    calculateATR: (history, period = 14) => {
        if (history.length < period) return 0;
        const ranges = [];
        for (let i = 1; i < history.length; i++) {
            const current = history[i].p || history[i];
            const previous = history[i - 1].p || history[i - 1];
            ranges.push(Math.abs(current - previous));
        }
        return MathLib.average(ranges.slice(-period));
    },

    getDerivatives: (history) => {
        if (history.length < 5) return { v: 0, a: 0 };
        const p = history.map(h => h.p || h);
        if (p.length < 6) return { v: 0, a: 0 };
        const v = (p[p.length - 1] - p[p.length - 5]) / 5;
        const vPrev = (p[p.length - 2] - p[p.length - 6]) / 5;
        const a = v - vPrev;
        return { v, a };
    },

    dtwDistance: (s1, s2) => {
        const n = s1.length, m = s2.length;
        const dtws = Array.from({ length: n + 1 }, () => Array(m + 1).fill(Infinity));
        dtws[0][0] = 0;
        for (let i = 1; i <= n; i++) {
            for (let j = 1; j <= m; j++) {
                const cost = Math.abs(s1[i - 1] - s2[j - 1]);
                dtws[i][j] = cost + Math.min(dtws[i - 1][j], dtws[i][j - 1], dtws[i - 1][j - 1]);
            }
        }
        return dtws[n][m];
    }
};

function findSimilarPattern(current, library, threshold = 0.8) {
    let bestMatch = null;
    let minDistance = Infinity;
    library.forEach(pattern => {
        const dist = MathLib.dtwDistance(current, pattern.data);
        if (dist < minDistance) {
            minDistance = dist;
            bestMatch = pattern;
        }
    });
    return minDistance < threshold ? bestMatch : null;
}

module.exports = { KalmanFilter, MathLib, findSimilarPattern };
