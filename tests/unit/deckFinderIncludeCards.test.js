/**
 * End-to-end search pipeline tests for include-cards (locked / required) flows.
 *
 * The helper-level suite (deckFinder.test.js) can't catch cross-component bugs:
 * these tests drive the REAL runSearch (main-thread fallback and real worker
 * file in a vm host) and assert invariants on the final results — deck size,
 * locked-card presence, user composition.
 *
 * Regression: GitHub issue #7 — owned mode with 5 locked cards (one per type)
 * returned 7-card decks, because warm-start seeds were built on friend
 * variants that couldn't host the locked cards.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { applyFixtureCollection, resetFixtures } = require('../fixtures');

const ROOT = path.resolve(__dirname, '..', '..');

// Renderer fn the manager calls but which the Node harness doesn't load
global.renderFinderResults = global.renderFinderResults || (() => {});

// Locked cards for the 5-locked scenarios — one per stat type (owned fixture cards)
const FIVE_LOCKED = [30002, 30004, 30005, 30001, 30010];
const ratio = (o) => ({ speed: 0, stamina: 0, power: 0, guts: 0, intelligence: 0, friend: 0, group: 0, ...o });
const RATIO_5_FRIEND = ratio({ speed: 1, stamina: 1, power: 1, guts: 1, intelligence: 1, friend: 1 });
const TYPES_3 = { speed: true, stamina: false, power: false, guts: false, intelligence: true, friend: true, group: false };

const typeById = {};
cardData.forEach(c => { typeById[c.support_id] = c.type; });

// ---------- Invariant helpers ----------

function assertAllSixCards(results) {
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
        expect(r.cardIds).toHaveLength(6);
    }
}

function assertLockedInEveryResult(results, ids) {
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
        for (const id of ids) {
            expect(r.cardIds.map(String)).toContain(String(id));
        }
    }
}

function assertAnyInEveryResult(results, ids) {
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
        expect(ids.some(id => r.cardIds.map(String).includes(String(id)))).toBe(true);
    }
}

function assertComposition(results, ratioObj) {
    for (const r of results) {
        const counts = {};
        r.cardIds.forEach(id => {
            const t = typeById[id] || '?';
            counts[t] = (counts[t] || 0) + 1;
        });
        for (const [t, n] of Object.entries(ratioObj)) {
            if (n > 0) expect({ type: t, got: counts[t], want: n }).toEqual({ type: t, got: n, want: n });
        }
    }
}

// ---------- Runner: main-thread path ----------

async function runSearchMain(filters) {
    resetFixtures();
    if (filters.cardPool === 'owned') applyFixtureCollection();

    const savedWorker = global.Worker;
    delete global.Worker; // force the main-thread fallback search
    let completed = null;
    try {
        await runSearch(
            filters,
            () => {},
            (results, message) => { completed = { results, message }; }
        );
    } finally {
        global.Worker = savedWorker; // restore MockWorker
    }
    expect(completed).not.toBeNull();
    return completed;
}

// ---------- Runner: worker path (real worker file in a vm host) ----------

const workerSrc = fs.readFileSync(path.join(ROOT, 'js', 'workers', 'deckFinderWorker.js'), 'utf-8')
    .replace("importScripts('../utils/debug.js');", '');

function runInVmWorker(payload) {
    const messages = [];
    const wctx = vm.createContext({
        self: {}, postMessage: (m) => messages.push(m),
        performance, console, _debug: global._debug,
    });
    vm.runInContext(workerSrc, wctx, { filename: 'deckFinderWorker.js' });
    wctx.self.onmessage({ data: { type: 'start', payload } });
    return messages.find(m => m.type === 'complete' || m.type === 'error');
}

async function runSearchWorker(filters) {
    resetFixtures();
    if (filters.cardPool === 'owned') applyFixtureCollection();

    const ctx = vm.createContext(global); // same context the setup loaded the manager into
    const savedRunWorker = global.runWorkerSearch;
    global.__vmWorkerRun = (payload) => runInVmWorker(payload);
    // Patch the dispatcher (inside the setup context so it can see lexical globals
    // like SCENARIO_WEIGHTS / deckFinderState). Mirrors the real multi-worker
    // payload, but runs all shards in a single synchronous worker.
    vm.runInContext(`
globalThis.__vmWorkerRun = globalThis.__vmWorkerRun;
runWorkerSearch = async function(filters, pool, cache, groups, maxTable, validDists, totalCombos,
    onProgress, onComplete, onLiveResults, warningMessage, friendCache, friendGroups, friendMaxTable,
    metricNorms, warmStartSeeds, searchPoolSize) {
    const cacheObj = {};
    cache.forEach((val, key) => {
        const sbt = {};
        if (val.skillsByType) for (const [t, s] of Object.entries(val.skillsByType)) sbt[t] = [...s];
        cacheObj[key] = { ...val, hintSkillIds: [...val.hintSkillIds], hintSkillTypes: [...val.hintSkillTypes], skillsByType: sbt, effectKeyArr: val.effectKeyArr, effectValArr: val.effectValArr };
    });
    const groupsObj = {};
    for (const [type, cards] of Object.entries(groups)) groupsObj[type] = cards.map(c => ({ support_id: c.support_id }));
    let friendCacheObj = null, friendGroupsObj = null;
    if (friendCache && friendGroups) {
        friendCacheObj = {};
        friendCache.forEach((val, key) => {
            const ownedEntry = cache.get(key);
            if (ownedEntry && ownedEntry.level === val.level) return;
            const fsbt = {};
            if (val.skillsByType) for (const [t, s] of Object.entries(val.skillsByType)) fsbt[t] = [...s];
            friendCacheObj[key] = { ...val, hintSkillIds: [...val.hintSkillIds], hintSkillTypes: [...val.hintSkillTypes], skillsByType: fsbt, effectKeyArr: val.effectKeyArr, effectValArr: val.effectValArr };
        });
        friendGroupsObj = {};
        for (const [type, cards] of Object.entries(friendGroups)) friendGroupsObj[type] = cards.map(c => ({ support_id: c.support_id }));
    }
    const scenarioId = filters.scenario || '1';
    const payload = {
        cache: cacheObj, groups: groupsObj, maxTable, validDists, totalCombos,
        filters: { ...filters, _stabilityPercent: 30 },
        resultCount: searchPoolSize,
        scenarioWeights: { [scenarioId]: { weights: getActiveWeights(scenarioId), raceBreakpoint: (SCENARIO_WEIGHTS[scenarioId] || {}).raceBreakpoint } },
        statBonusEffectIds: STAT_BONUS_EFFECT_IDS,
        skillTypeBitMap: Object.fromEntries(_skillTypeBitMap),
        traineeData: deckFinderState.traineeData,
        cardTypeGrowthKey: CARD_TYPE_GROWTH_KEY,
        metricNorms,
        friendCache: friendCacheObj,
        friendGroups: friendGroupsObj,
        lockedCardIds: (filters.includeCardsMode === 'all') ? (filters.includeCards || []) : [],
        anyRequiredCardIds: (filters.includeCardsMode === 'any' && (filters.includeCards || []).length > 0) ? filters.includeCards : [],
        initialSeeds: warmStartSeeds || [],
    };
    let msg;
    try { msg = __vmWorkerRun(payload); } catch (e) { onComplete([], 'worker harness error: ' + e.message); return; }
    if (!msg) { onComplete([], 'worker silent'); return; }
    if (msg.type === 'error') { onComplete([], msg.message); return; }
    deckFinderState.results = msg.results;
    deckFinderState.searching = false;
    onComplete(msg.results, warningMessage);
};
`, ctx);
    let completed = null;
    try {
        await runSearch(
            filters,
            () => {},
            (results, message) => { completed = { results, message }; }
        );
    } finally {
        global.runWorkerSearch = savedRunWorker;
        delete global.__vmWorkerRun;
    }
    expect(completed).not.toBeNull();
    return completed;
}

const baseFilters = () => {
    const base = getDefaultFinderFilters();
    base.resultCount = 20;
    return base;
};

// ===== MAIN-THREAD PATH =====

describe('runSearch (main thread) — include cards', () => {
    test('owned, 5 locked (one per type) + ratio 1x5+friend:1 → exactly-6-card decks, issue #7 regression', async () => {
        const { results } = await runSearchMain({
            ...baseFilters(),
            cardPool: 'owned',
            includeCards: FIVE_LOCKED,
            includeCardsMode: 'all',
            typeRatio: RATIO_5_FRIEND,
        });
        assertAllSixCards(results);
        assertLockedInEveryResult(results, FIVE_LOCKED);
        assertComposition(results, RATIO_5_FRIEND);
        // Friend slot populated, distinct from player cards
        for (const r of results) {
            expect(r.friendCardId).toBeTruthy();
            expect(r.cardIds).toContain(r.friendCardId);
        }
    }, 60000);

    test('owned, defaults (no ratio) + 1 locked → 6-card decks containing the lock', async () => {
        const { results } = await runSearchMain({
            ...baseFilters(),
            cardPool: 'owned',
            includeCards: [30002],
            includeCardsMode: 'all',
        });
        assertAllSixCards(results);
        assertLockedInEveryResult(results, [30002]);
    }, 60000);

    test('all-cards, 5 locked + ratio 1x5+friend:1 → 6-card decks containing all locks', async () => {
        const { results } = await runSearchMain({
            ...baseFilters(),
            cardPool: 'all',
            includeCards: FIVE_LOCKED,
            includeCardsMode: 'all',
            typeRatio: RATIO_5_FRIEND,
        });
        assertAllSixCards(results);
        assertLockedInEveryResult(results, FIVE_LOCKED);
        assertComposition(results, RATIO_5_FRIEND);
    }, 60000);

    test('locked type conflicts with the user ratio → graceful conflict message, zero results', async () => {
        const { results, message } = await runSearchMain({
            ...baseFilters(),
            cardPool: 'all',
            types: TYPES_3,
            includeCards: [30082], // intelligence card
            includeCardsMode: 'all',
            typeRatio: ratio({ speed: 5, friend: 1 }), // no intelligence slots
        });
        expect(results).toEqual([]);
        expect(message).toMatch(/don't fit your type composition/i);
    }, 60000);

    test('any-mode, 2 required cards → every result contains at least one', async () => {
        const { results } = await runSearchMain({
            ...baseFilters(),
            cardPool: 'all',
            types: TYPES_3,
            includeCards: [30082, 30018],
            includeCardsMode: 'any',
            typeRatio: ratio({ speed: 3, intelligence: 2, friend: 1 }),
        });
        assertAllSixCards(results);
        assertAnyInEveryResult(results, [30082, 30018]);
        assertComposition(results, ratio({ speed: 3, intelligence: 2, friend: 1 }));
    }, 60000);

    test('owned, includeFriendCards → every result uses the selected friend card', async () => {
        const { results } = await runSearchMain({
            ...baseFilters(),
            cardPool: 'owned',
            includeFriendCards: [30021],
            includeCardsMode: 'all',
            typeRatio: ratio({ speed: 2, stamina: 1, power: 1, guts: 1, friend: 1 }),
        });
        expect(results.length).toBeGreaterThan(0);
        for (const r of results) {
            expect(r.friendCardId).toBe(30021);
            expect(r.cardIds.map(String)).toContain('30021');
        }
    }, 60000);
});

// ===== WORKER PATH =====

describe('runSearch (worker) — include cards', () => {
    test('owned, 5 locked (one per type) + ratio 1x5+friend:1 → exactly-6-card decks, issue #7 regression', async () => {
        const { results } = await runSearchWorker({
            ...baseFilters(),
            cardPool: 'owned',
            includeCards: FIVE_LOCKED,
            includeCardsMode: 'all',
            typeRatio: RATIO_5_FRIEND,
        });
        assertAllSixCards(results);
        assertLockedInEveryResult(results, FIVE_LOCKED);
        assertComposition(results, RATIO_5_FRIEND);
    }, 60000);

    test('all-cards, 5 locked + ratio 1x5+friend:1 → 6-card decks containing all locks', async () => {
        const { results } = await runSearchWorker({
            ...baseFilters(),
            cardPool: 'all',
            includeCards: FIVE_LOCKED,
            includeCardsMode: 'all',
            typeRatio: RATIO_5_FRIEND,
        });
        assertAllSixCards(results);
        assertLockedInEveryResult(results, FIVE_LOCKED);
        assertComposition(results, RATIO_5_FRIEND);
    }, 60000);

    test('owned, defaults (no ratio) + 1 locked → 6-card decks containing the lock', async () => {
        const { results } = await runSearchWorker({
            ...baseFilters(),
            cardPool: 'owned',
            includeCards: [30002],
            includeCardsMode: 'all',
        });
        assertAllSixCards(results);
        assertLockedInEveryResult(results, [30002]);
    }, 60000);
});
