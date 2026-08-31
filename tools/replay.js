// Replays a draft pick by pick, printing the recommendation at each of my turns.
//
//   node tools/replay.js                          synthetic value-ordered draft
//   node tools/replay.js draft.json               a captured draft
//   node tools/replay.js draft.json --team 104    override which seat is mine
//
// A capture is whatever `FDA_EXPORT` writes: { settings, players, picks, myTeamId }.
// A raw league response with a `draftDetail` key is also accepted, in which case
// the player pool must be supplied alongside it via --pool.

const fs = require('node:fs');
const path = require('node:path');
const { DS, makeSettings, makePool, strategy, vor, recommend } = require('../test/harness');

function parseArgs(argv) {
  const out = { file: null, pool: null, teamId: null, rounds: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--team') out.teamId = Number(argv[++i]);
    else if (arg === '--pool') out.pool = argv[++i];
    else if (arg === '--rounds') out.rounds = Number(argv[++i]);
    else if (!out.file) out.file = arg;
  }
  return out;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
}

// Rough approximation of how real drafters value each position relative to raw
// VOR. Kickers and defenses are worth points but nobody spends an early pick on
// them, so the board has to reflect that or the replay never sees a late board.
const BOARD_BIAS = { RB: 1.0, WR: 1.0, TE: 0.85, QB: 0.6, DST: 0.15, K: 0.1 };

// Opponents take the most valuable undrafted player. Crude, but it drains the
// board in a plausible order, which is what the replay is exercising.
function syntheticDraft(pool, settings, totalPicks) {
  const { players: valued } = vor.buildValuation({
    players: pool,
    settings,
    teamCount: settings.teamCount,
    strategy,
    projectionOf: (p) => p.projectedPoints
  });
  const board = [...valued].sort(
    (a, b) => b.vor * (BOARD_BIAS[b.position] ?? 1) - a.vor * (BOARD_BIAS[a.position] ?? 1)
  );

  // Make ADP agree with the board, otherwise the survival model is reasoning
  // about a draft order that never happens.
  board.forEach((p, i) => { pool.find((q) => q.id === p.id).adp = i + 1; });

  const picks = [];
  let cursor = 0;
  for (let overall = 1; overall <= totalPicks; overall++) {
    const player = board[cursor++];
    if (!player) break;
    picks.push({
      playerId: player.id,
      teamId: DS.teamAtPick(settings.draft.pickOrder, overall),
      round: Math.ceil(overall / settings.teamCount),
      roundPick: ((overall - 1) % settings.teamCount) + 1,
      overall,
      keeper: false,
      autoDraft: true
    });
  }
  return picks;
}

function loadCapture(args) {
  if (!args.file) {
    const settings = makeSettings({ teamCount: 10 });
    const players = makePool();
    const totalRounds = DS.rosterSize(settings.slotCounts);
    return {
      settings,
      players,
      myTeamId: args.teamId ?? settings.draft.pickOrder[2],
      picks: syntheticDraft(players, settings, totalRounds * settings.teamCount),
      label: 'synthetic ADP-ordered draft'
    };
  }

  const raw = readJson(args.file);
  const players = args.pool ? readJson(args.pool) : raw.players;
  if (!Array.isArray(players)) {
    throw new Error('no player pool: pass --pool <file> or capture one in the bundle');
  }
  const picks = raw.picks || (raw.draftDetail && raw.draftDetail.picks) || [];
  return {
    settings: raw.settings,
    players,
    myTeamId: args.teamId ?? raw.myTeamId,
    picks,
    label: path.basename(args.file)
  };
}

const pad = (s, n) => String(s).padEnd(n);

function printTurn(result, capture, actualPick) {
  const { meta, rosterState } = result;
  console.log('');
  console.log('='.repeat(78));
  console.log(
    `Round ${meta.currentRound}  ·  overall pick ${meta.currentPick}  ·  ` +
      `next turn at ${meta.nextPick ?? '—'}  ·  ${meta.availableCount} available`
  );
  console.log('='.repeat(78));

  const filled = Object.entries(rosterState.filled)
    .map(([pos, n]) => `${pos}${n}`)
    .join(' ') || '(empty)';
  console.log(`Roster: ${filled}   RB/WR bench ${rosterState.benchRbWr}` +
    (rosterState.urgent ? '   [URGENT]' : ''));

  for (const alert of result.positionalAlerts) {
    console.log(`  ! ${alert.severity.toUpperCase()}: ${alert.message}`);
  }

  result.top5.forEach((entry, i) => {
    const p = entry.player;
    console.log(
      `  ${i + 1}. ${pad(p.name, 10)} ${pad(p.position, 4)} ` +
        `vor ${pad(entry.vor, 7)} score ${pad(entry.finalScore.toFixed(1), 8)} ` +
        `surv ${Math.round(entry.survivalProbability * 100)}%`
    );
    console.log(`     ${entry.reason}`);
  });

  if (result.offPlanValue) {
    for (const entry of result.offPlanValue) {
      console.log(`  ~ off-plan value: ${entry.player.name} — ${entry.reason}`);
    }
  }

  if (actualPick) {
    const hit = result.top5.some((e) => e.player.id === actualPick.id);
    console.log(`  -> actually drafted: ${actualPick.name} (${actualPick.position})` +
      `${hit ? '  [in top 5]' : '  [not recommended]'}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const capture = loadCapture(args);
  const playersById = new Map(capture.players.map((p) => [p.id, p]));

  const state = DS.createState({ settings: capture.settings, myTeamId: capture.myTeamId });
  const ordered = [...capture.picks].sort((a, b) => a.overall - b.overall);

  console.log(`Replaying ${capture.label}`);
  console.log(`Team ${capture.myTeamId} · ${capture.settings.teamCount} teams · ` +
    `${state.totalRounds} rounds · ${ordered.length} picks on record`);

  let turns = 0;
  let hits = 0;
  const limit = args.rounds ? args.rounds * capture.settings.teamCount : Infinity;

  for (let overall = 1; overall <= Math.min(ordered.length, limit); overall++) {
    const isMine = DS.teamAtPick(state.pickOrder, overall) === capture.myTeamId;

    if (isMine) {
      const result = recommend.recommend(state, capture.players, strategy);
      const actual = playersById.get(ordered[overall - 1].playerId) || null;
      printTurn(result, capture, actual);
      turns++;
      if (actual && result.top5.some((e) => e.player.id === actual.id)) hits++;
    }

    DS.applyPicks(state, ordered.slice(0, overall), 'api');
  }

  console.log('');
  console.log('-'.repeat(78));
  console.log(`${turns} turns replayed · ${hits} of them drafted someone in the top 5`);
}

main();
