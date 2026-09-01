const { test } = require('node:test');
const assert = require('node:assert');
const { DS, makeSettings, makeState } = require('./harness');

const order = [101, 102, 103, 104, 105, 106, 107, 108, 109, 110];

test('snake: odd rounds follow pick order, even rounds reverse it', () => {
  const r1 = Array.from({ length: 10 }, (_, i) => DS.teamAtPick(order, i + 1));
  const r2 = Array.from({ length: 10 }, (_, i) => DS.teamAtPick(order, i + 11));
  const r3 = Array.from({ length: 10 }, (_, i) => DS.teamAtPick(order, i + 21));

  assert.deepStrictEqual(r1, order);
  assert.deepStrictEqual(r2, [...order].reverse());
  assert.deepStrictEqual(r3, order);
});

test('snake: turn boundary gives the wheel team back-to-back picks', () => {
  assert.strictEqual(DS.teamAtPick(order, 10), 110);
  assert.strictEqual(DS.teamAtPick(order, 11), 110);
  assert.strictEqual(DS.teamAtPick(order, 20), 101);
  assert.strictEqual(DS.teamAtPick(order, 21), 101);
});

test('my pick numbers round-trip through teamAtPick', () => {
  for (const teamId of order) {
    const picks = DS.myPickNumbers(order, teamId, 16);
    assert.strictEqual(picks.length, 16);
    for (const pick of picks) {
      assert.strictEqual(DS.teamAtPick(order, pick), teamId, `pick ${pick} for team ${teamId}`);
    }
  }
});

test('slot 3 of 10 picks at 3, 18, 23, 38', () => {
  assert.deepStrictEqual(DS.myPickNumbers(order, 103, 4), [3, 18, 23, 38]);
});

test('roster size counts bench and flex but excludes IR', () => {
  // QB1 RB2 WR2 TE1 DST1 K1 FLEX1 = 9 starters + 7 bench = 16, IR not drafted
  assert.strictEqual(DS.rosterSize({ 0: 1, 2: 2, 4: 2, 6: 1, 16: 1, 17: 1, 20: 7, 21: 1, 23: 1 }), 16);
});

test('dedicated slots fill before flex absorbs surplus', () => {
  const state = makeState();
  const players = [
    { id: 1, position: 'RB' }, { id: 2, position: 'RB' }, { id: 3, position: 'RB' },
    { id: 4, position: 'WR' }, { id: 5, position: 'WR' }
  ];
  state.rostersByTeam.set(101, players.map((p) => p.id));
  const comp = DS.rosterComposition(state, new Map(players.map((p) => [p.id, p])));

  // RB2 and WR2 filled, third RB takes FLEX, nothing left on the bench.
  assert.strictEqual(comp.unfilledStartingSlots[2], undefined);
  assert.strictEqual(comp.unfilledStartingSlots[4], undefined);
  assert.strictEqual(comp.unfilledStartingSlots[23], undefined);
  assert.strictEqual(comp.benchRbWr, 0);
});

test('surplus beyond starters and flex counts as RB/WR bench', () => {
  const state = makeState();
  const players = [
    { id: 1, position: 'RB' }, { id: 2, position: 'RB' }, { id: 3, position: 'RB' },
    { id: 4, position: 'RB' }, { id: 5, position: 'WR' }, { id: 6, position: 'WR' },
    { id: 7, position: 'WR' }
  ];
  state.rostersByTeam.set(101, players.map((p) => p.id));
  const comp = DS.rosterComposition(state, new Map(players.map((p) => [p.id, p])));

  assert.strictEqual(comp.benchRbWr, 2);
  assert.deepStrictEqual(comp.benchDepth, { RB: 1, WR: 1 });
});

test('api sync reconciles away picks the API no longer reports', () => {
  const state = makeState();
  const pick = (playerId, overall) => ({
    playerId, teamId: 101, round: 1, roundPick: overall, overall, keeper: false, autoDraft: false
  });

  DS.applyPicks(state, [pick(1, 1), pick(2, 2)], 'api');
  assert.strictEqual(state.draftedPlayerIds.size, 2);

  // DOM layer optimistically adds a pick the API never confirms.
  DS.applyPicks(state, [pick(99, 3)], 'dom');
  assert.ok(state.draftedPlayerIds.has(99));

  const delta = DS.applyPicks(state, [pick(1, 1), pick(2, 2)], 'api');
  assert.deepStrictEqual(delta.removed, [99]);
  assert.ok(!state.draftedPlayerIds.has(99));
});

test('next pick and distance advance as picks land', () => {
  const settings = makeSettings({ teamCount: 10 });
  const state = makeState({ settings, myTeamId: 103 });
  assert.strictEqual(DS.nextPickForMe(state), 3);
  assert.strictEqual(DS.picksUntilMyTurn(state), 2);

  const picks = Array.from({ length: 5 }, (_, i) => ({
    playerId: i + 1, teamId: DS.teamAtPick(state.pickOrder, i + 1),
    round: 1, roundPick: i + 1, overall: i + 1, keeper: false, autoDraft: false
  }));
  DS.applyPicks(state, picks, 'api');

  assert.strictEqual(DS.currentOverallPick(state), 6);
  assert.strictEqual(DS.nextPickForMe(state), 18);
});

// The DOM layer drops picks whose player it cannot identify, so a gapped list
// is its normal output, not a corruption. Counting rows would point the whole
// panel at a turn that has already passed.
test('a gapped pick list still reports the right pick on the clock', () => {
  const settings = makeSettings({ teamCount: 10 });
  const state = makeState({ settings, myTeamId: 103 });

  // Picks 1-8 happened; 4 and 7 could not be matched to a player.
  const seen = [1, 2, 3, 5, 6, 8];
  DS.applyPicks(
    state,
    seen.map((overall) => ({
      playerId: overall * 10,
      teamId: DS.teamAtPick(state.pickOrder, overall),
      round: 1,
      roundPick: overall,
      overall,
      keeper: false,
      autoDraft: false
    })),
    'dom'
  );

  assert.strictEqual(state.picks.length, 6);
  assert.strictEqual(DS.currentOverallPick(state), 9);
  assert.strictEqual(DS.picksUntilMyTurn(state), 9); // my next is 18
});

test("ESPN's own clock carries the counter when the API reports no picks", () => {
  const settings = makeSettings({ teamCount: 10 });
  const state = makeState({ settings, myTeamId: 103 });

  // A live draft: the API knows nothing, and the board only rendered the last
  // few picks, so the panel has matched 4 of the 62 that have happened.
  DS.applyPicks(
    state,
    [55, 56, 57, 58].map((overall) => ({
      playerId: overall * 10,
      teamId: DS.teamAtPick(state.pickOrder, overall),
      round: 6,
      roundPick: overall - 50,
      overall,
      keeper: false,
      autoDraft: false
    })),
    'dom'
  );

  assert.strictEqual(DS.currentOverallPick(state), 59);
  state.observedPick = 63;
  assert.strictEqual(DS.currentOverallPick(state), 63);

  // It only ever moves the counter forward — a clock reading behind what we
  // have actually seen is the stale one.
  state.observedPick = 12;
  assert.strictEqual(DS.currentOverallPick(state), 59);
});
