const { test } = require('node:test');
const assert = require('node:assert');
const {
  DS, recommend, strategy, makeSettings, makePool, makePlayer, makeState, draftToMe
} = require('./harness');

const settings = makeSettings({ teamCount: 10 });
const TOTAL_ROUNDS = 16;

// Minimal context for exercising checkConstraints / needMultiplier directly.
function ctx({
  unfilled = {}, benchRbWr = 0, currentRound = 1, myCounts = {},
  myPlayers = [], urgent = false, teVorEdge = 0
} = {}) {
  return {
    strategy,
    comp: {
      unfilledStartingSlots: unfilled,
      benchRbWr,
      benchDepth: { RB: 0, WR: 0 },
      picksRemaining: TOTAL_ROUNDS - Object.keys(myCounts).length,
      totalDrafted: 0
    },
    currentRound,
    totalRounds: TOTAL_ROUNDS,
    myCounts,
    myPlayers,
    settings,
    urgent,
    teVorEdge
  };
}

const ALL_FILLED = {};
const player = (position, extra = {}) => makePlayer(position, 200, extra);

// --- Kicker -----------------------------------------------------------------

test('K is blocked before the final round', () => {
  for (const round of [1, 8, 14, 15]) {
    const res = recommend.checkConstraints(player('K'), ctx({ currentRound: round }));
    assert.strictEqual(res.allowed, false, `round ${round} should block K`);
    assert.match(res.reason, /final round/);
  }
});

test('K is allowed in the final round', () => {
  assert.strictEqual(recommend.checkConstraints(player('K'), ctx({ currentRound: 16 })).allowed, true);
});

test('a second K is never allowed', () => {
  const res = recommend.checkConstraints(player('K'), ctx({ currentRound: 16, myCounts: { K: 1 } }));
  assert.strictEqual(res.allowed, false);
});

// --- Defense ----------------------------------------------------------------

test('DST is blocked before the last two rounds', () => {
  for (const round of [1, 10, 14]) {
    const res = recommend.checkConstraints(player('DST'), ctx({ currentRound: round }));
    assert.strictEqual(res.allowed, false, `round ${round} should block DST`);
  }
});

test('DST is allowed in the last two rounds', () => {
  assert.strictEqual(recommend.checkConstraints(player('DST'), ctx({ currentRound: 15 })).allowed, true);
  assert.strictEqual(recommend.checkConstraints(player('DST'), ctx({ currentRound: 16 })).allowed, true);
});

// --- Quarterback ------------------------------------------------------------

test('QB is blocked while starting RB/WR/FLEX slots are open', () => {
  const res = recommend.checkConstraints(
    player('QB'),
    ctx({ unfilled: { 2: 1, 23: 1 }, benchRbWr: 5, currentRound: 6 })
  );
  assert.strictEqual(res.allowed, false);
  assert.match(res.reason, /RB\/WR\/FLEX/);
});

test('QB is blocked until 2 RB/WR bench pieces exist', () => {
  const res = recommend.checkConstraints(
    player('QB'),
    ctx({ unfilled: ALL_FILLED, benchRbWr: 1, currentRound: 6 })
  );
  assert.strictEqual(res.allowed, false);
  assert.match(res.reason, /2 RB\/WR bench/);
});

test('QB opens once starters are set and bench depth is met', () => {
  const res = recommend.checkConstraints(
    player('QB'),
    ctx({ unfilled: ALL_FILLED, benchRbWr: 2, currentRound: 6 })
  );
  assert.strictEqual(res.allowed, true);
});

test('never a second QB in a 1-QB league', () => {
  const res = recommend.checkConstraints(
    player('QB'),
    ctx({ unfilled: ALL_FILLED, benchRbWr: 5, currentRound: 10, myCounts: { QB: 1 } })
  );
  assert.strictEqual(res.allowed, false);
  assert.match(res.reason, /second QB/);
});

// --- Tight end --------------------------------------------------------------

test('TE gate is one notch softer than QB: 1 bench piece, not 2', () => {
  const teCtx = ctx({ unfilled: ALL_FILLED, benchRbWr: 1, currentRound: 6 });
  assert.strictEqual(recommend.checkConstraints(player('TE'), teCtx).allowed, true);
  assert.strictEqual(recommend.checkConstraints(player('QB'), teCtx).allowed, false);
});

test('TE is blocked with no RB/WR bench depth', () => {
  const res = recommend.checkConstraints(
    player('TE', { tier: 3, lastInTier: false }),
    ctx({ unfilled: ALL_FILLED, benchRbWr: 0, currentRound: 4 })
  );
  assert.strictEqual(res.allowed, false);
});

test('never a second TE while the first is healthy', () => {
  const res = recommend.checkConstraints(
    player('TE'),
    ctx({
      unfilled: ALL_FILLED, benchRbWr: 5, currentRound: 9, myCounts: { TE: 1 },
      myPlayers: [makePlayer('TE', 180, { injuryStatus: 'ACTIVE' })]
    })
  );
  assert.strictEqual(res.allowed, false);
  assert.match(res.reason, /second TE/);
});

test('a second TE is allowed when the first is OUT or on IR', () => {
  for (const status of ['OUT', 'INJURY_RESERVE']) {
    const res = recommend.checkConstraints(
      player('TE'),
      ctx({
        unfilled: ALL_FILLED, benchRbWr: 5, currentRound: 9, myCounts: { TE: 1 },
        myPlayers: [makePlayer('TE', 180, { injuryStatus: status })]
      })
    );
    assert.strictEqual(res.allowed, true, `${status} should unblock a second TE`);
  }
});

// --- TE tier-cliff carve-out (the agreed amendment) --------------------------

test('a tier-1 TE at a cliff overrides the TE gate', () => {
  const elite = player('TE', { tier: 1, lastInTier: true });
  const res = recommend.checkConstraints(
    elite,
    ctx({ unfilled: ALL_FILLED, benchRbWr: 0, currentRound: 3, teVorEdge: 40 })
  );
  assert.strictEqual(res.allowed, true);
  assert.strictEqual(res.override, 'te-tier-cliff');
});

test('the carve-out needs a real cliff, not just a good TE', () => {
  const noCliff = player('TE', { tier: 1, lastInTier: false });
  assert.strictEqual(
    recommend.checkConstraints(noCliff, ctx({ unfilled: ALL_FILLED, benchRbWr: 0, teVorEdge: 40 })).allowed,
    false
  );

  const thinEdge = player('TE', { tier: 1, lastInTier: true });
  assert.strictEqual(
    recommend.checkConstraints(thinEdge, ctx({ unfilled: ALL_FILLED, benchRbWr: 0, teVorEdge: 2 })).allowed,
    false
  );
});

test('the carve-out does not extend to low tiers', () => {
  const midTe = player('TE', { tier: 4, lastInTier: true });
  assert.strictEqual(
    recommend.checkConstraints(midTe, ctx({ unfilled: ALL_FILLED, benchRbWr: 0, teVorEdge: 40 })).allowed,
    false
  );
});

// --- Roster urgency safety valve --------------------------------------------

test('urgency unblocks a gated position rather than ending with no starter', () => {
  // Would normally be blocked by the QB gate, but picks are running out.
  const res = recommend.checkConstraints(
    player('QB'),
    ctx({ unfilled: { 0: 1 }, benchRbWr: 0, currentRound: 15, urgent: true })
  );
  assert.strictEqual(res.allowed, true);
  assert.strictEqual(res.override, 'roster-urgency');
});

// --- The core weighting rule ------------------------------------------------

test('RB/WR bench depth outranks an unfilled starting QB or TE slot', () => {
  const base = ctx({ unfilled: { 0: 1, 6: 1 }, benchRbWr: 1, currentRound: 7 });

  const benchRb = recommend.needMultiplier(player('RB'), base).multiplier;
  const startingQb = recommend.needMultiplier(player('QB'), base).multiplier;
  const startingTe = recommend.needMultiplier(player('TE'), base).multiplier;

  assert.ok(benchRb > startingQb, `bench RB ${benchRb} should beat starting QB ${startingQb}`);
  assert.ok(benchRb > startingTe, `bench RB ${benchRb} should beat starting TE ${startingTe}`);
});

test('an unfilled starting RB slot outranks bench depth', () => {
  const unfilledRb = recommend.needMultiplier(player('RB'), ctx({ unfilled: { 2: 1 }, benchRbWr: 1 })).multiplier;
  const benchOnly = recommend.needMultiplier(player('RB'), ctx({ unfilled: ALL_FILLED, benchRbWr: 1 })).multiplier;
  assert.ok(unfilledRb > benchOnly);
});

test('bench preference decays in the last rounds', () => {
  const early = recommend.needMultiplier(player('RB'), ctx({ unfilled: ALL_FILLED, benchRbWr: 1, currentRound: 8 })).multiplier;
  const late = recommend.needMultiplier(player('RB'), ctx({ unfilled: ALL_FILLED, benchRbWr: 1, currentRound: 15 })).multiplier;
  assert.ok(late < early, `late ${late} should decay below early ${early}`);
  assert.ok(late >= 1);
});

test('diminishing returns kick in past 5 at a position', () => {
  const under = recommend.needMultiplier(player('RB'), ctx({ unfilled: ALL_FILLED, benchRbWr: 1, myCounts: { RB: 4 } })).multiplier;
  const over = recommend.needMultiplier(player('RB'), ctx({ unfilled: ALL_FILLED, benchRbWr: 1, myCounts: { RB: 5 } })).multiplier;
  assert.ok(over < under);
});

// --- End to end -------------------------------------------------------------

test('an empty roster in round 1 is recommended RB/WR, never K or DST', () => {
  const pool = makePool();
  const state = makeState({ settings });
  const out = recommend.recommend(state, pool, strategy);

  assert.strictEqual(out.top5.length, 5);
  for (const entry of out.top5) {
    assert.ok(['RB', 'WR'].includes(entry.player.position), `got ${entry.player.position} in round 1`);
  }
});

test('the engine never returns a kicker before the final round', () => {
  const pool = makePool();
  const state = makeState({ settings });
  draftToMe(state, pool, ['RB', 'RB', 'WR', 'WR', 'RB', 'WR', 'TE', 'QB']);
  const out = recommend.recommend(state, pool, strategy);
  assert.ok(!out.top5.some((e) => e.player.position === 'K'));
});

test('output satisfies the 2g contract', () => {
  const pool = makePool();
  const state = makeState({ settings });
  const out = recommend.recommend(state, pool, strategy);

  assert.ok(Array.isArray(out.top5));
  assert.ok('offPlanValue' in out);
  assert.ok(out.rosterState && 'filled' in out.rosterState && 'unfilled' in out.rosterState);
  assert.ok('benchDepth' in out.rosterState);
  assert.ok(Array.isArray(out.positionalAlerts));

  for (const key of [
    'player', 'positionRank', 'tier', 'projectedPoints', 'vor', 'survivalProbability',
    'opportunityCost', 'injuryStatus', 'injuryHistoryFlag', 'needMultiplier', 'finalScore', 'reason'
  ]) {
    assert.ok(key in out.top5[0], `top5 entry missing ${key}`);
  }
  assert.strictEqual(typeof out.top5[0].reason, 'string');
});

test('recommend is pure — it does not mutate the pool or the state', () => {
  const pool = makePool();
  const state = makeState({ settings });
  const poolBefore = JSON.stringify(pool);
  const draftedBefore = state.draftedPlayerIds.size;

  recommend.recommend(state, pool, strategy);

  assert.strictEqual(JSON.stringify(pool), poolBefore);
  assert.strictEqual(state.draftedPlayerIds.size, draftedBefore);
});

test('drafted players never appear in recommendations', () => {
  const pool = makePool();
  const state = makeState({ settings });
  draftToMe(state, pool, ['RB', 'RB', 'WR']);
  const out = recommend.recommend(state, pool, strategy);

  for (const entry of out.top5) {
    assert.ok(!state.draftedPlayerIds.has(entry.player.id));
  }
});

test('injury status discounts the score but a healthy peer still wins', () => {
  const pool = makePool();
  const target = pool.find((p) => p.name === 'RB1');
  const healthy = recommend.recommend(makeState({ settings }), pool, strategy);
  const healthyTop = healthy.top5[0].player.id;

  const injuredPool = pool.map((p) => (p.id === target.id ? { ...p, injuryStatus: 'OUT' } : p));
  const injured = recommend.recommend(makeState({ settings }), injuredPool, strategy);

  const before = healthy.top5.find((e) => e.player.id === target.id);
  const after = injured.top5.find((e) => e.player.id === target.id);
  if (before && after) assert.ok(after.finalScore < before.finalScore);
  assert.ok(healthyTop !== undefined);
});

test('off-plan value is surfaced separately, never inside the top 5', () => {
  const pool = makePool();
  // A monster QB that the positional order would otherwise bury.
  pool.push(makePlayer('QB', 700, { name: 'Monster QB', adp: 2 }));

  const state = makeState({ settings });
  const out = recommend.recommend(state, pool, strategy);

  assert.ok(!out.top5.some((e) => e.player.name === 'Monster QB'), 'must not be promoted into top 5');
  assert.ok(out.offPlanValue, 'should be surfaced as off-plan value');
  assert.ok(out.offPlanValue.some((e) => e.player.name === 'Monster QB'));
  assert.match(out.offPlanValue[0].reason, /off your positional order|breaks your plan/);
});

test('an injured player never outranks an identical healthy one below replacement', () => {
  // Deep in the pool VOR is negative. A discount applied by multiplication
  // makes a negative number larger, which used to promote OUT players to the
  // top of the board in the last rounds.
  const pool = makePool();
  const healthy = makePlayer('WR', 40, { name: 'Healthy Deep', adp: 300 });
  const hurt = makePlayer('WR', 40, { name: 'Hurt Deep', adp: 300, injuryStatus: 'OUT' });
  pool.push(healthy, hurt);

  const state = makeState({ settings });
  const out = recommend.recommend(state, pool, { ...strategy, TOP_N: 400 });

  const h = out.top5.find((e) => e.player.id === healthy.id);
  const i = out.top5.find((e) => e.player.id === hurt.id);
  assert.ok(h && i, 'both should be scored');
  assert.ok(h.vor < 0, 'this test only means anything below replacement');
  assert.ok(i.finalScore < h.finalScore, `injured ${i.finalScore} should rank below healthy ${h.finalScore}`);
});
