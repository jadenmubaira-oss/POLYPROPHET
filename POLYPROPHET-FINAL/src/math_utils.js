/**
 * POLYPROPHET FINAL: MATH UTILITIES
 */

class KalmanFilter {
    constructor(q = 0.0001, r = 0.001) {
        this.q = q;
        this.r = r;
        this.x = null;
        this.p = 1.0;
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
        if (history.length < period) return 0.0001; // Minimum ATR
        const ranges = [];
        for (let i = 1; i < history.length; i++) {
            const current = history[i].p || history[i];
            const previous = history[i - 1].p || history[i - 1];
            ranges.push(Math.abs(current - previous));
        }
        return MathLib.average(ranges.slice(-period)) || 0.0001;
    },

    getDerivatives: (history) => {
        if (history.length < 6) return { v: 0, a: 0 };
        const p = history.map(h => h.p || h);
        const v = (p[p.length - 1] - p[p.length - 5]) / 5;
        const vPrev = (p[p.length - 2] - p[p.length - 6]) / 5;
        const a = v - vPrev;
        return { v, a };
    }
};

module.exports = { KalmanFilter, MathLib };

