// Draft state: snake pick order, drafted-player tracking, roster composition.
// Pure logic — no DOM, no network.
(function (root) {
  'use strict';

  const SLOT = {
    QB: 0, RB: 2, RB_WR: 3, WR: 4, WR_TE: 5, TE: 6,
    DST: 16, K: 17, BENCH: 20, IR: 21, FLEX: 23
  };

  const FLEX_ELIGIBLE = new Set(['RB', 'WR', 'TE']);

  // Slots that consume a draft pick. IR is excluded: it isn't drafted into.
  function rosterSize(slotCounts) {
    let total = 0;
    for (const [id, count] of Object.entries(slotCounts || {})) {
      if (Number(id) === SLOT.IR) continue;
      total += count;
    }
    return total;
  }

  function startingSlots(slotCounts) {
    const out = {};
    for (const [id, count] of Object.entries(slotCounts || {})) {
      const slotId = Number(id);
      if (slotId === SLOT.IR || slotId === SLOT.BENCH) continue;
      out[slotId] = count;
    }
    return out;
  }

  // Snake: odd rounds follow pickOrder, even rounds reverse it.
  function teamAtPick(pickOrder, overall) {
    const n = pickOrder.length;
    if (!n || overall < 1) return null;
    const round = Math.ceil(overall / n);
    const idxInRound = overall - (round - 1) * n; // 1-based
    const slot = round % 2 === 1 ? idxInRound : n - idxInRound + 1;
    return pickOrder[slot - 1] ?? null;
  }

  function overallForRound(pickOrder, draftSlot, round) {
    const n = pickOrder.length;
    if (!n || !draftSlot) return null;
    const idxInRound = round % 2 === 1 ? draftSlot : n - draftSlot + 1;
    return (round - 1) * n + idxInRound;
  }

  function myPickNumbers(pickOrder, myTeamId, totalRounds) {
    const slot = pickOrder.indexOf(myTeamId) + 1;
    if (slot === 0) return [];
    const picks = [];
    for (let r = 1; r <= totalRounds; r++) {
      picks.push(overallForRound(pickOrder, slot, r));
    }
    return picks;
  }

  function createState({ settings, myTeamId }) {
    const pickOrder = settings.draft.pickOrder.slice();
    const teamCount = settings.teamCount || pickOrder.length;
    const totalRounds = rosterSize(settings.slotCounts);

    return {
      settings,
      myTeamId,
      pickOrder,
      teamCount,
      totalRounds,
      myDraftSlot: pickOrder.indexOf(myTeamId) + 1 || null,
      myPicks: myPickNumbers(pickOrder, myTeamId, totalRounds),
      picks: [],
      draftedPlayerIds: new Set(),
      rostersByTeam: new Map(),
      // ESPN's own clock, when it is the only thing that knows where the draft
      // is. Null whenever the API can answer that question itself.
      observedPick: null,
      lastSyncAt: null,
      source: 'none'
    };
  }

  // Returns what changed so callers can log a delta instead of the whole board.
  function applyPicks(state, picks, source) {
    const seen = new Set();
    const added = [];
    const ordered = picks
      .slice()
      .sort((a, b) => (a.overall || 0) - (b.overall || 0));

    for (const pick of ordered) {
      if (seen.has(pick.playerId)) continue;
      seen.add(pick.playerId);
      if (!state.draftedPlayerIds.has(pick.playerId)) added.push(pick);
    }

    // The API is authoritative: players it no longer reports as drafted were
    // either mis-detected by the DOM layer or undone by a commissioner edit.
    const removed = [];
    if (source === 'api') {
      for (const id of state.draftedPlayerIds) {
        if (!seen.has(id)) removed.push(id);
      }
    }

    if (source === 'api') {
      state.picks = ordered;
      state.draftedPlayerIds = seen;
      state.rostersByTeam = new Map();
      for (const pick of ordered) {
        if (!state.rostersByTeam.has(pick.teamId)) state.rostersByTeam.set(pick.teamId, []);
        state.rostersByTeam.get(pick.teamId).push(pick.playerId);
      }
    } else {
      for (const pick of added) {
        state.picks.push(pick);
        state.draftedPlayerIds.add(pick.playerId);
        if (!state.rostersByTeam.has(pick.teamId)) state.rostersByTeam.set(pick.teamId, []);
        state.rostersByTeam.get(pick.teamId).push(pick.playerId);
      }
    }

    state.lastSyncAt = Date.now();
    state.source = source;
    return { added, removed };
  }

  // Counting picks is only right when none are missing, and the DOM layer sees
  // whatever the page has rendered — often a window of recent picks with high
  // overall numbers and nothing before them. So the highest pick seen wins over
  // the number of them. Implausible coordinates are rejected upstream, where
  // the round on the clock is known to reject them against.
  function currentOverallPick(state) {
    const count = state.picks.length;
    let highest = 0;
    for (const pick of state.picks) {
      if (pick.overall > highest) highest = pick.overall;
    }
    const counted = Math.max(count, highest) + 1;

    // Counting only works if we saw the picks. During a live draft ESPN's API
    // reports nothing at all, so the board is the only record and it shows just
    // what is currently rendered. The clock on screen still knows where the
    // draft is, and it can only move the counter forward.
    return state.observedPick > counted ? state.observedPick : counted;
  }

  function nextPickForMe(state) {
    const current = currentOverallPick(state);
    return state.myPicks.find((p) => p >= current) ?? null;
  }

  function picksUntilMyTurn(state) {
    const next = nextPickForMe(state);
    return next === null ? null : next - currentOverallPick(state);
  }

  function roundOf(state, overall) {
    if (!state.teamCount) return 0;
    return Math.ceil(overall / state.teamCount);
  }

  // Which starting slots are filled vs open, plus RB/WR bench depth.
  function rosterComposition(state, playersById) {
    const myPlayerIds = state.rostersByTeam.get(state.myTeamId) || [];
    const byPosition = {};
    for (const id of myPlayerIds) {
      const p = playersById.get(id);
      if (!p) continue;
      byPosition[p.position] = (byPosition[p.position] || 0) + 1;
    }

    const starting = startingSlots(state.settings.slotCounts);
    const need = {};
    const remaining = { ...byPosition };

    const SLOT_TO_POS = {
      [SLOT.QB]: ['QB'], [SLOT.RB]: ['RB'], [SLOT.WR]: ['WR'], [SLOT.TE]: ['TE'],
      [SLOT.DST]: ['DST'], [SLOT.K]: ['K'],
      [SLOT.FLEX]: ['RB', 'WR', 'TE'], [SLOT.RB_WR]: ['RB', 'WR'], [SLOT.WR_TE]: ['WR', 'TE']
    };

    // Fill dedicated slots before flex so flex absorbs only genuine surplus.
    const slotIds = Object.keys(starting)
      .map(Number)
      .sort((a, b) => (SLOT_TO_POS[a]?.length || 9) - (SLOT_TO_POS[b]?.length || 9));

    for (const slotId of slotIds) {
      const eligible = SLOT_TO_POS[slotId] || [];
      let open = starting[slotId];
      for (const pos of eligible) {
        while (open > 0 && (remaining[pos] || 0) > 0) {
          remaining[pos]--;
          open--;
        }
      }
      if (open > 0) need[slotId] = open;
    }

    const benchDepth = { RB: remaining.RB || 0, WR: remaining.WR || 0 };

    return {
      totalDrafted: myPlayerIds.length,
      byPosition,
      unfilledStartingSlots: need,
      benchDepth,
      benchRbWr: benchDepth.RB + benchDepth.WR,
      benchSlots: state.settings.benchSlots,
      picksRemaining: Math.max(0, state.totalRounds - myPlayerIds.length)
    };
  }

  root.FDADraftState = {
    SLOT,
    FLEX_ELIGIBLE,
    rosterSize,
    startingSlots,
    teamAtPick,
    overallForRound,
    myPickNumbers,
    createState,
    applyPicks,
    currentOverallPick,
    nextPickForMe,
    picksUntilMyTurn,
    roundOf,
    rosterComposition
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
