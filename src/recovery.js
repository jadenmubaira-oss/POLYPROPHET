/**
 * OMEGA V2: MASTER RECOVERY MODULE
 * 
 * Logic: Synchronizes Redis-persisted state with real-time cycles.
 * Identifies 'Orphaned Positions' from server crashes and moves them to the recovery queue.
 */

class OMEGA_Recovery {
    constructor(logger) {
        this.log = logger || console.log;
    }

    /**
     * @param {Object} teState - Persisted TradeExecutor state
     * @param {number} currentCycle - Current 900s cycle timestamp
     */
    reconcile(teState, currentCycle) {
        const active = {};
        const recovery = teState.recoveryQueue || [];
        const orphaned = [];

        if (!teState.positions) return { active, recovery };

        Object.entries(teState.positions).forEach(([id, pos]) => {
            const posCycle = Math.floor(pos.time / 1000);
            const posCycleStart = posCycle - (posCycle % 900);

            if (posCycleStart < currentCycle) {
                this.log(`[OMEGA-RECOVERY] ⚠️ Found Orphaned Position: ${id} (Cycle: ${posCycleStart})`);
                orphaned.push({
                    ...pos,
                    status: 'ORPHANED_BY_CRASH',
                    recoveryTime: Date.now()
                });
            } else {
                active[id] = pos;
            }
        });

        return {
            active,
            recovery: [...recovery, ...orphaned]
        };
    }
}

module.exports = OMEGA_Recovery;
