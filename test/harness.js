// Loads the browser-global engine modules into a Node context for testing.
// Load order matters: recommend.js destructures its dependencies at load time.
require('../content/draft-state.js');
require('../engine/strategy.js');
require('../engine/scoring.js');
require('../engine/vor.js');
require('../engine/survival.js');
require('../engine/recommend.js');

const DS = globalThis.FDADraftState;

// 2026 ESPN default roster: QB1 RB2 WR2 TE1 DST1 K1 FLEX1 + 7 bench (+IR).
const DEFAULT_SLOT_COUNTS = { 0: 1, 2: 2, 4: 2, 6: 1, 16: 1, 17: 1, 20: 7, 21: 1, 23: 1 };

function makeSettings(overrides = {}) {
  const teamCount = overrides.teamCount || 10;
  return {
    leagueName: 'Test League',
    teamCount,
    slotCounts: overrides.slotCounts || DEFAULT_SLOT_COUNTS,
    benchSlots: 7,
    scoringItems: { 53: 1, 42: 0.04, 43: 4, 24: 0.1, 25: 6, 12: 6 },
    receptionPoints: 1,
    playerRankType: 'PPR',
    draft: {
      type: 'SNAKE',
      pickOrder: overrides.pickOrder || Array.from({ length: teamCount }, (_, i) => 101 + i),
      timePerSelection: 90,
      keeperCount: 0
    },
    ...overrides
  };
}

let nextId = 1;
function makePlayer(position, projectedPoints, extra = {}) {
  return {
    id: extra.id ?? nextId++,
    name: extra.name || `${position}${projectedPoints}`,
    position,
    positionId: { QB: 1, RB: 2, WR: 3, TE: 4, K: 5, DST: 16 }[position],
    proTeamId: 1,
    eligibleSlots: [],
    injuryStatus: extra.injuryStatus || 'ACTIVE',
    injured: false,
    percentOwned: 50,
    adp: extra.adp ?? 100,
    auctionValue: 0,
    draftRankPPR: 0,
    draftRankStandard: 0,
    projectedPoints,
    projectedStats: extra.projectedStats || {},
    onTeamId: 0,
    ...extra
  };
}

// A pool with a realistic descending curve at every position. The per-position
// step matters: kickers and defenses are nearly interchangeable in reality, and
// a uniform step would hand K1 a huge VOR that the real data never produces.
const POSITION_STEP = { QB: 7.5, RB: 7.5, WR: 7.5, TE: 7.5, K: 1.5, DST: 2.5 };

function makePool({ counts = { QB: 24, RB: 50, WR: 60, TE: 24, K: 12, DST: 12 }, base = {} } = {}) {
  const tops = { QB: 380, RB: 340, WR: 330, TE: 250, K: 140, DST: 130, ...base };
  const players = [];
  let adp = 1;
  for (const [position, count] of Object.entries(counts)) {
    for (let i = 0; i < count; i++) {
      players.push(
        makePlayer(position, Math.round(tops[position] - i * POSITION_STEP[position]), {
          name: `${position}${i + 1}`,
          adp: adp++
        })
      );
    }
  }
  return players;
}

function makeState({ settings = makeSettings(), myTeamId = 101, picks = [] } = {}) {
  const state = DS.createState({ settings, myTeamId });
  if (picks.length) DS.applyPicks(state, picks, 'api');
  return state;
}

// Fills my roster with specific positions by fabricating picks.
function draftToMe(state, pool, positions) {
  const used = new Set(state.draftedPlayerIds);
  const picks = [...state.picks];
  let overall = picks.length + 1;
  for (const position of positions) {
    const player = pool.find((p) => p.position === position && !used.has(p.id));
    if (!player) throw new Error(`no free ${position} in pool`);
    used.add(player.id);
    picks.push({
      playerId: player.id,
      teamId: state.myTeamId,
      round: Math.ceil(overall / state.teamCount),
      roundPick: 1,
      overall,
      keeper: false,
      autoDraft: false
    });
    overall++;
  }
  DS.applyPicks(state, picks, 'api');
  return state;
}

module.exports = {
  DS,
  DEFAULT_SLOT_COUNTS,
  makeSettings,
  makePlayer,
  makePool,
  makeState,
  draftToMe,
  strategy: globalThis.FDAStrategy,
  vor: globalThis.FDAVor,
  survival: globalThis.FDASurvival,
  scoring: globalThis.FDAScoring,
  recommend: globalThis.FDARecommend
};
