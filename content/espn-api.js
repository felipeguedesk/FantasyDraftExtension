// ESPN v3 fantasy API client. Runs in the content script so ESPN's CORS policy
// (which reflects only https://fantasy.espn.com) and the espn_s2/SWID cookies apply.
(function (root) {
  'use strict';

  const BASE = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons';

  // Every field access goes through these so a shape change degrades to a
  // typed default instead of throwing mid-draft.
  const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const int = (v, d = null) => (Number.isInteger(v) ? v : d);
  const str = (v, d = '') => (typeof v === 'string' ? v : d);
  const bool = (v, d = false) => (typeof v === 'boolean' ? v : d);
  const arr = (v) => (Array.isArray(v) ? v : []);
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

  const POSITION_BY_ID = { 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'DST' };
  const POOL_SLOT_IDS = [0, 2, 4, 6, 16, 17];

  // ESPN advertises its own rate limit via a response header; honor it when present.
  let pollingIntervalMs = null;
  const getPollingIntervalMs = () => pollingIntervalMs;

  function leagueUrl(seasonId, leagueId, views) {
    const v = arr(views).map((x) => `view=${encodeURIComponent(x)}`).join('&');
    return `${BASE}/${seasonId}/segments/0/leagues/${leagueId}?${v}`;
  }

  async function request(url, { filter = null, signal = null } = {}) {
    const headers = { Accept: 'application/json' };
    if (filter) headers['X-Fantasy-Filter'] = JSON.stringify(filter);

    const res = await fetch(url, {
      method: 'GET',
      // Required: lm-api-reads is a different origin from fantasy.espn.com, so
      // the auth cookies only ride along with explicit credentials.
      credentials: 'include',
      headers,
      signal
    });

    const advertised = Number(res.headers.get('Polling-Interval'));
    if (Number.isFinite(advertised) && advertised > 0) {
      pollingIntervalMs = advertised < 1000 ? advertised * 1000 : advertised;
    }

    if (!res.ok) {
      const err = new Error(`ESPN API ${res.status} ${res.statusText}`);
      err.status = res.status;
      err.url = url;
      throw err;
    }
    return res.json();
  }

  function parseSettings(raw) {
    const s = obj(obj(raw).settings);
    const roster = obj(s.rosterSettings);
    const scoring = obj(s.scoringSettings);
    const draft = obj(s.draftSettings);

    const slotCounts = {};
    for (const [k, v] of Object.entries(obj(roster.lineupSlotCounts))) {
      const id = Number(k);
      if (Number.isInteger(id) && num(v, 0) > 0) slotCounts[id] = num(v, 0);
    }

    const scoringItems = {};
    for (const item of arr(scoring.scoringItems)) {
      const id = int(obj(item).statId);
      if (id === null) continue;
      scoringItems[id] = num(obj(item).points, 0);
    }

    return {
      leagueName: str(s.name, 'Unknown league'),
      teamCount: int(s.size, 0) || arr(draft.pickOrder).length,
      slotCounts,
      benchSlots: num(slotCounts[20], 0),
      scoringItems,
      // 0 = standard, 1 = PPR-ish; the receptions coefficient is authoritative.
      receptionPoints: num(scoringItems[53], 0),
      scoringType: str(scoring.scoringType, ''),
      playerRankType: str(scoring.playerRankType, 'PPR'),
      draft: {
        type: str(draft.type, 'SNAKE'),
        pickOrder: arr(draft.pickOrder).filter(Number.isInteger),
        timePerSelection: num(draft.timePerSelection, 0),
        keeperCount: num(draft.keeperCount, 0)
      }
    };
  }

  function scoringLabel(settings) {
    const r = num(obj(settings).receptionPoints, 0);
    if (r >= 0.9) return 'PPR';
    if (r > 0) return 'HALF_PPR';
    return 'STANDARD';
  }

  function parsePlayer(wrapper) {
    const w = obj(wrapper);
    const p = obj(w.player);
    const id = int(p.id);
    if (id === null) return null;

    const ownership = obj(p.ownership);
    const ranks = obj(p.draftRanksByRankType);

    const seasonProjection = arr(p.stats).find(
      (s) =>
        int(obj(s).statSourceId) === 1 &&
        int(obj(s).statSplitTypeId) === 0 &&
        int(obj(s).scoringPeriodId) === 0
    );

    return {
      id,
      name: str(p.fullName, `Player ${id}`),
      positionId: int(p.defaultPositionId, -1),
      position: POSITION_BY_ID[int(p.defaultPositionId, -1)] || 'UNK',
      proTeamId: int(p.proTeamId, 0),
      eligibleSlots: arr(p.eligibleSlots).filter(Number.isInteger),
      injuryStatus: str(p.injuryStatus, 'ACTIVE'),
      injured: bool(p.injured, false),
      percentOwned: num(ownership.percentOwned, 0),
      adp: num(ownership.averageDraftPosition, 0),
      auctionValue: num(ownership.auctionValueAverage, 0),
      draftRankPPR: num(obj(ranks.PPR).rank, 0),
      draftRankStandard: num(obj(ranks.STANDARD).rank, 0),
      // appliedTotal is scored by the requesting league, verified empirically:
      // PPR 364.98 vs STANDARD 297.08 for the same player, delta = receptions.
      projectedPoints: num(obj(seasonProjection).appliedTotal, 0),
      projectedStats: obj(obj(seasonProjection).stats),
      onTeamId: int(w.onTeamId, 0)
    };
  }

  async function fetchSettings(seasonId, leagueId) {
    const raw = await request(leagueUrl(seasonId, leagueId, ['mSettings']));
    return { settings: parseSettings(raw), raw };
  }

  async function fetchPlayerPool(seasonId, leagueId, { limit = 500, rankType = 'PPR' } = {}) {
    const filter = {
      players: {
        filterStatus: { value: ['FREEAGENT', 'WAIVERS', 'ONTEAM'] },
        filterSlotIds: { value: POOL_SLOT_IDS },
        limit,
        sortDraftRanks: { sortPriority: 100, sortAsc: true, value: rankType }
      }
    };
    const raw = await request(
      leagueUrl(seasonId, leagueId, ['kona_player_info']),
      { filter }
    );

    const players = [];
    let skipped = 0;
    for (const w of arr(obj(raw).players)) {
      const parsed = parsePlayer(w);
      if (parsed) players.push(parsed);
      else skipped++;
    }
    return { players, skipped };
  }

  async function fetchTeams(seasonId, leagueId) {
    const raw = await request(leagueUrl(seasonId, leagueId, ['mTeam', 'mRoster']));
    const teams = arr(obj(raw).teams).map((t) => {
      const team = obj(t);
      return {
        id: int(team.id, 0),
        name:
          str(team.name) ||
          `${str(team.location)} ${str(team.nickname)}`.trim() ||
          `Team ${int(team.id, 0)}`,
        abbrev: str(team.abbrev, ''),
        owners: arr(team.owners).map(String),
        rosterPlayerIds: arr(obj(obj(team.roster)).entries)
          .map((e) => int(obj(e).playerId))
          .filter((x) => x !== null)
      };
    });
    return { teams, raw };
  }

  async function fetchDraftDetail(seasonId, leagueId) {
    const raw = await request(leagueUrl(seasonId, leagueId, ['mDraftDetail']));
    const detail = obj(obj(raw).draftDetail);
    const picks = arr(detail.picks)
      .map((x) => {
        const pick = obj(x);
        const playerId = int(pick.playerId);
        if (playerId === null) return null;
        return {
          playerId,
          teamId: int(pick.teamId, 0),
          round: int(pick.roundId, 0),
          roundPick: int(pick.roundPickNumber, 0),
          overall: int(pick.overallPickNumber, 0),
          keeper: bool(pick.keeper, false),
          autoDraft: int(pick.autoDraftTypeId, 0) !== 0
        };
      })
      .filter(Boolean);

    return {
      inProgress: bool(detail.inProgress, false),
      drafted: bool(detail.drafted, false),
      picks,
      raw
    };
  }

  // ---- injury narrative ----
  //
  // The fantasy API gives a status code and nothing else. "Q" is the difference
  // between a tweaked ankle and a player who will not practice all week, and
  // that difference is not in the draft data. This is strictly decoration: it is
  // fetched lazily on expand, never blocks a recommendation, and every failure
  // path degrades to the status code that was already on screen.
  const CORE = 'https://sports.core.api.espn.com/v2/sports/football/leagues/nfl';
  const INJURY_TTL_MS = 15 * 60 * 1000;
  const INJURY_MAX_ITEMS = 2;
  const injuryCache = new Map();

  // ESPN's core API hands back $ref links, occasionally over plain http.
  const secure = (url) => str(url, '').replace(/^http:/, 'https:');

  async function coreRequest(url, signal) {
    const res = await fetch(secure(url), { method: 'GET', headers: { Accept: 'application/json' }, signal });
    if (!res.ok) throw new Error(`ESPN core API ${res.status}`);
    return res.json();
  }

  function parseInjuryItem(raw) {
    const item = obj(raw);
    const details = obj(item.details);
    const text = str(item.longComment, '') || str(item.shortComment, '');
    return {
      status: str(item.status, ''),
      type: str(details.type, ''),
      detail: str(details.detail, ''),
      side: str(details.side, ''),
      returnDate: str(details.returnDate, ''),
      fantasyStatus: str(obj(details.fantasyStatus).description, ''),
      date: str(item.date, ''),
      text
    };
  }

  // playerId doubles as the NFL athlete id for real players, which lets this hit
  // one athlete directly instead of walking a team's whole injury list.
  async function fetchInjuryNarrative(playerId, { signal = null, maxAgeMs = INJURY_TTL_MS } = {}) {
    if (!Number.isInteger(playerId)) return null;

    const cached = injuryCache.get(playerId);
    if (cached && Date.now() - cached.at < maxAgeMs) return cached.value;

    try {
      const list = await coreRequest(`${CORE}/athletes/${playerId}/injuries?limit=5`, signal);
      const refs = arr(obj(list).items).slice(0, INJURY_MAX_ITEMS);
      const items = [];
      for (const ref of refs) {
        const url = str(obj(ref).$ref, '');
        if (!url) continue;
        items.push(parseInjuryItem(await coreRequest(url, signal)));
      }
      const value = items.length ? items : null;
      injuryCache.set(playerId, { at: Date.now(), value });
      return value;
    } catch {
      // Cache the miss too: a 404 for a healthy player is the common case and
      // should not be retried on every expand.
      injuryCache.set(playerId, { at: Date.now(), value: null });
      return null;
    }
  }

  root.FDAApi = {
    POSITION_BY_ID,
    POOL_SLOT_IDS,
    INJURY_TTL_MS,
    getPollingIntervalMs,
    scoringLabel,
    fetchSettings,
    fetchPlayerPool,
    fetchTeams,
    fetchDraftDetail,
    fetchInjuryNarrative
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
