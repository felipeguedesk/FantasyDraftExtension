const { test } = require('node:test');
const assert = require('node:assert');
const { vor, strategy, makeSettings, makePool, makePlayer } = require('./harness');

const slotCounts = { 0: 1, 2: 2, 4: 2, 6: 1, 16: 1, 17: 1, 20: 7, 21: 1, 23: 1 };

test('replacement rank = teams x dedicated slots, plus a flex share', () => {
  // QB has 1 dedicated slot, no flex share -> 10 teams x 1 = 10
  assert.strictEqual(vor.replacementRank('QB', slotCounts, 10, strategy), 10);
  // RB: 2 dedicated + 0.45 of 1 flex = 2.45 x 10 = 24.5 -> 25
  assert.strictEqual(vor.replacementRank('RB', slotCounts, 10, strategy), 25);
  // WR: 2 dedicated + 0.50 of 1 flex = 2.5 x 10 = 25
  assert.strictEqual(vor.replacementRank('WR', slotCounts, 10, strategy), 25);
  // TE: 1 dedicated + 0.05 of 1 flex = 1.05 x 10 = 10.5 -> 11
  assert.strictEqual(vor.replacementRank('TE', slotCounts, 10, strategy), 11);
});

test('replacement rank scales with league size', () => {
  assert.strictEqual(vor.replacementRank('QB', slotCounts, 12, strategy), 12);
  assert.strictEqual(vor.replacementRank('RB', slotCounts, 12, strategy), 29);
});

test('flex share shifts replacement deeper only for flex-eligible positions', () => {
  const noFlex = { ...slotCounts, 23: 0 };
  assert.strictEqual(vor.replacementRank('RB', noFlex, 10, strategy), 20);
  assert.strictEqual(vor.replacementRank('K', noFlex, 10, strategy), 10);
  assert.strictEqual(vor.replacementRank('K', slotCounts, 10, strategy), 10);
});

test('VOR is projection minus the replacement-rank projection', () => {
  const players = [];
  // RB1..RB30 at 300, 290, ... so RB25 (replacement) projects 300-24*10 = 60
  for (let i = 0; i < 30; i++) {
    players.push(makePlayer('RB', 300 - i * 10, { name: `RB${i + 1}`, adp: i + 1 }));
  }
  const { players: valued, replacementByPosition } = vor.buildValuation({
    players,
    settings: makeSettings({ slotCounts }),
    teamCount: 10,
    strategy,
    projectionOf: (p) => p.projectedPoints
  });

  assert.strictEqual(replacementByPosition.RB.rank, 25);
  assert.strictEqual(replacementByPosition.RB.points, 60);

  const rb1 = valued.find((p) => p.name === 'RB1');
  assert.strictEqual(rb1.vor, 240);
  assert.strictEqual(rb1.positionRank, 1);

  // The replacement player himself has zero VOR by definition.
  assert.strictEqual(valued.find((p) => p.name === 'RB25').vor, 0);
  // Players below replacement are negative.
  assert.ok(valued.find((p) => p.name === 'RB30').vor < 0);
});

test('replacement baseline uses the full pool, not just the undrafted', () => {
  // buildValuation is given every player; depleting the pool must not move it.
  const pool = makePool();
  const full = vor.buildValuation({
    players: pool,
    settings: makeSettings({ slotCounts }),
    teamCount: 10,
    strategy,
    projectionOf: (p) => p.projectedPoints
  });
  const depleted = vor.buildValuation({
    players: pool.filter((p) => !(p.position === 'RB' && Number(p.name.slice(2)) <= 10)),
    settings: makeSettings({ slotCounts }),
    teamCount: 10,
    strategy,
    projectionOf: (p) => p.projectedPoints
  });

  assert.notStrictEqual(full.replacementByPosition.RB.points, depleted.replacementByPosition.RB.points);
});

test('tier breaks land on gaps beyond mean + 1.2 sigma', () => {
  // Three tight clusters separated by large gaps.
  const values = [200, 198, 196, 150, 148, 146, 100, 98, 96];
  const players = values.map((v, i) => ({ id: i + 1, name: `P${i + 1}`, vor: v }));
  vor.assignTiers(players, strategy);

  assert.deepStrictEqual(players.map((p) => p.tier), [1, 1, 1, 2, 2, 2, 3, 3, 3]);
  assert.deepStrictEqual(
    players.map((p) => p.lastInTier),
    [false, false, true, false, false, true, false, false, true]
  );
});

test('an evenly spaced position produces a single tier', () => {
  const players = Array.from({ length: 12 }, (_, i) => ({ id: i, name: `P${i}`, vor: 100 - i * 5 }));
  vor.assignTiers(players, strategy);
  assert.deepStrictEqual([...new Set(players.map((p) => p.tier))], [1]);
});

test('tiny positions collapse to tier 1 with the last player flagged', () => {
  const players = [{ id: 1, vor: 50 }, { id: 2, vor: 10 }];
  vor.assignTiers(players, strategy);
  assert.deepStrictEqual(players.map((p) => p.tier), [1, 1]);
  assert.strictEqual(players[1].lastInTier, true);
});
