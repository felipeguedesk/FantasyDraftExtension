const { test } = require('node:test');
const assert = require('node:assert');
const { survival, strategy, makePlayer } = require('./harness');

const ctx = (currentPick, nextPick, opposingRosters = []) => ({
  currentPick, nextPick, poolSize: 400, opposingRosters
});

test('sigma grows with ADP and never drops below the floor', () => {
  assert.strictEqual(survival.adpSigma(1.35, strategy), strategy.ADP_SIGMA_FLOOR);
  assert.ok(survival.adpSigma(100, strategy) > survival.adpSigma(20, strategy));
  assert.strictEqual(survival.adpSigma(100, strategy), 35);
});

test('an elite player does not survive a full round — the flat-sigma bug', () => {
  // With a flat sigma of 8 this returned a meaningful probability, which is
  // nonsense: an ADP 1.35 player never lasts to pick 15.
  const elite = makePlayer('RB', 350, { adp: 1.35 });
  const p = survival.survivalProbability(elite, ctx(2, 15), strategy);
  assert.ok(p < 0.01, `expected near-zero survival, got ${p}`);
});

test('survival falls as the wait gets longer', () => {
  const player = makePlayer('WR', 250, { adp: 30 });
  const short = survival.survivalProbability(player, ctx(20, 24), strategy);
  const long = survival.survivalProbability(player, ctx(20, 45), strategy);
  assert.ok(short > long);
  assert.ok(short <= 1 && long >= 0);
});

test('probabilities stay within [0,1] across the whole ADP range', () => {
  for (const adp of [1, 5, 25, 80, 150, 400]) {
    for (const [now, next] of [[1, 2], [10, 30], [100, 130], [200, 240]]) {
      const p = survival.survivalProbability(makePlayer('RB', 100, { adp }), ctx(now, next), strategy);
      assert.ok(p >= 0 && p <= 1, `adp=${adp} ${now}->${next} gave ${p}`);
    }
  }
});

test('a player who already outlasted his ADP is conditioned on still being here', () => {
  // Conditioning matters: falling past ADP means he keeps falling.
  const faller = makePlayer('RB', 250, { adp: 10 });
  const p = survival.survivalProbability(faller, ctx(40, 44), strategy);
  assert.ok(p > 0, 'conditional survival must not collapse to zero');
  assert.ok(p <= 1);
});

test('no next pick means guaranteed availability', () => {
  const player = makePlayer('RB', 250, { adp: 5 });
  assert.strictEqual(survival.survivalProbability(player, ctx(10, null), strategy), 1);
});

test('players missing ADP are parked behind the pool, not treated as steals', () => {
  const unknown = makePlayer('WR', 90, { adp: 0 });
  assert.strictEqual(
    survival.effectiveAdp(unknown, 400, strategy),
    400 * strategy.ADP_MISSING_FALLBACK_MULTIPLIER
  );
  assert.ok(survival.survivalProbability(unknown, ctx(10, 30), strategy) > 0.9);
});

test('saturated opponents reduce demand for a position', () => {
  const hungry = [{ RB: 0 }, { RB: 1 }];
  const stacked = [{ RB: 4 }, { RB: 5 }];
  assert.strictEqual(survival.opponentDemand('RB', hungry, strategy), 1);
  assert.strictEqual(
    survival.opponentDemand('RB', stacked, strategy),
    strategy.OPPONENT_SATURATED_DEMAND
  );
});

test('a player survives longer when the teams ahead are stacked at his position', () => {
  const player = makePlayer('RB', 250, { adp: 25 });
  const stacked = Array.from({ length: 8 }, () => ({ RB: 5 }));
  const hungry = Array.from({ length: 8 }, () => ({ RB: 0 }));

  const withStacked = survival.survivalProbability(player, ctx(20, 28, stacked), strategy);
  const withHungry = survival.survivalProbability(player, ctx(20, 28, hungry), strategy);
  assert.ok(withStacked > withHungry);
});

test('expected best VOR sits between the second player and the best', () => {
  const group = [
    { id: 1, vor: 100 }, { id: 2, vor: 80 }, { id: 3, vor: 60 }
  ];
  const probs = new Map([[1, 0.5], [2, 0.5], [3, 1.0]]);
  const expected = survival.expectedBestVor(group, probs);

  // 100*0.5 + 80*0.5*0.5 + 60*1*0.25 = 50 + 20 + 15 = 85
  assert.ok(Math.abs(expected - 85) < 1e-9, `got ${expected}`);
});

test('opportunity cost is zero when the best player is certain to survive', () => {
  const group = [{ id: 1, vor: 100 }, { id: 2, vor: 80 }];
  const certain = new Map([[1, 1], [2, 1]]);
  assert.strictEqual(survival.opportunityCost(group, certain), 0);
});

test('opportunity cost equals the drop-off when the best is certain to go', () => {
  const group = [{ id: 1, vor: 100 }, { id: 2, vor: 80 }];
  const doomed = new Map([[1, 0], [2, 1]]);
  assert.strictEqual(survival.opportunityCost(group, doomed), 20);
});
