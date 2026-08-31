// Pure, synchronous orchestrator. No DOM, no network, no clock.
// recommend(draftState, playerPool, strategy) -> the 2g contract.
(function (root) {
  'use strict';

  const { FDAVor, FDASurvival, FDADraftState } = root;

  const SLOT = FDADraftState.SLOT;
  const RB_WR_FLEX_SLOTS = [SLOT.RB, SLOT.WR, SLOT.FLEX, SLOT.RB_WR];
  const MANDATORY_SLOTS = [SLOT.QB, SLOT.RB, SLOT.WR, SLOT.TE, SLOT.DST, SLOT.K, SLOT.FLEX];

  const SLOT_ELIGIBILITY = {
    [SLOT.QB]: ['QB'],
    [SLOT.RB]: ['RB'],
    [SLOT.WR]: ['WR'],
    [SLOT.TE]: ['TE'],
    [SLOT.DST]: ['DST'],
    [SLOT.K]: ['K'],
    [SLOT.FLEX]: ['RB', 'WR', 'TE'],
    [SLOT.RB_WR]: ['RB', 'WR'],
    [SLOT.WR_TE]: ['WR', 'TE']
  };

  const round1 = (x) => Math.round(x * 10) / 10;

  function injuryDiscount(status, strategy) {
    return strategy.INJURY_DISCOUNT[status] ?? 1.0;
  }

  // Position counts for a set of player ids.
  function positionCounts(playerIds, playersById) {
    const counts = {};
    for (const id of playerIds || []) {
      const p = playersById.get(id);
      if (p) counts[p.position] = (counts[p.position] || 0) + 1;
    }
    return counts;
  }

  // Rosters of the teams picking between now and my next turn, so the survival
  // model can discount positions those teams are already saturated at.
  function opposingRostersBefore(state, playersById) {
    const current = FDADraftState.currentOverallPick(state);
    const next = FDADraftState.nextPickForMe(state);
    if (next === null) return [];
    const out = [];
    for (let pick = current; pick < next; pick++) {
      const teamId = FDADraftState.teamAtPick(state.pickOrder, pick);
      if (teamId === null || teamId === state.myTeamId) continue;
      out.push(positionCounts(state.rostersByTeam.get(teamId), playersById));
    }
    return out;
  }

  function unfilledMandatoryCount(unfilled) {
    return Object.entries(unfilled)
      .filter(([slotId]) => MANDATORY_SLOTS.includes(Number(slotId)))
      .reduce((sum, [, n]) => sum + n, 0);
  }

  function startingRbWrFlexFilled(unfilled) {
    return !Object.keys(unfilled).some((slotId) =>
      RB_WR_FLEX_SLOTS.includes(Number(slotId))
    );
  }

  function fillsSlot(position, unfilled, slotIds) {
    for (const slotId of slotIds) {
      if (!unfilled[slotId]) continue;
      if ((SLOT_ELIGIBILITY[slotId] || []).includes(position)) return slotId;
    }
    return null;
  }

  // Hard constraints from 2d. Returns why a player is off-limits, plus any
  // override that legitimately unblocks them.
  function checkConstraints(player, ctx) {
    const { strategy, comp, currentRound, totalRounds, myCounts, myPlayers, settings, urgent } = ctx;
    const pos = player.position;
    const roundsFromEnd = totalRounds - currentRound;
    const fillsMandatory = fillsSlot(pos, comp.unfilledStartingSlots, MANDATORY_SLOTS) !== null;

    // The safety valve: never let a gate run the draft out without a starter.
    if (urgent && fillsMandatory) {
      return { allowed: true, override: 'roster-urgency' };
    }

    if (pos === 'K') {
      if (roundsFromEnd > strategy.K_ROUNDS_FROM_END) {
        return { allowed: false, reason: 'Kicker: final round only' };
      }
      if ((myCounts.K || 0) >= 1) return { allowed: false, reason: 'Already have a K' };
      return { allowed: true };
    }

    if (pos === 'DST') {
      if (roundsFromEnd > strategy.DST_ROUNDS_FROM_END) {
        return { allowed: false, reason: 'Defense: last two rounds only' };
      }
      if ((myCounts.DST || 0) >= 1) return { allowed: false, reason: 'Already have a DST' };
      return { allowed: true };
    }

    if (pos === 'QB') {
      const qbSlots = settings.slotCounts[SLOT.QB] || 0;
      if ((myCounts.QB || 0) >= 1 && qbSlots <= 1) {
        return { allowed: false, reason: 'Never a second QB in a 1-QB league' };
      }
      if (!startingRbWrFlexFilled(comp.unfilledStartingSlots)) {
        return { allowed: false, reason: 'QB gate: starting RB/WR/FLEX not filled' };
      }
      if (comp.benchRbWr < strategy.QB_REQUIRES_BENCH_RB_WR) {
        return {
          allowed: false,
          reason: `QB gate: need ${strategy.QB_REQUIRES_BENCH_RB_WR} RB/WR bench first`
        };
      }
      return { allowed: true };
    }

    if (pos === 'TE') {
      if ((myCounts.TE || 0) >= 1) {
        const firstTeInjured = myPlayers.some(
          (p) =>
            p.position === 'TE' &&
            strategy.SECOND_TE_ALLOWED_IF_INJURED.includes(p.injuryStatus)
        );
        if (!firstTeInjured) {
          return { allowed: false, reason: 'Never a second TE unless the first is OUT/IR' };
        }
      }

      const gateOpen =
        startingRbWrFlexFilled(comp.unfilledStartingSlots) &&
        comp.benchRbWr >= strategy.TE_REQUIRES_BENCH_RB_WR;

      if (gateOpen) return { allowed: true };

      // TE tier-cliff carve-out: TE is the most tier-cliffed position in
      // fantasy, so a genuine cliff may override the gate. Deliberately narrow.
      if (
        strategy.TE_TIER_CLIFF_OVERRIDE &&
        player.tier <= strategy.TE_CLIFF_MAX_TIER &&
        player.lastInTier &&
        ctx.teVorEdge >= strategy.TE_CLIFF_MIN_VOR_EDGE
      ) {
        return { allowed: true, override: 'te-tier-cliff' };
      }

      return { allowed: false, reason: 'TE gate: build RB/WR depth first' };
    }

    return { allowed: true };
  }

  // Soft weighting. The deliberate ordering is documented in strategy.js:
  // RB/WR bench depth outranks an unfilled TE/QB/DST/K starting slot.
  function needMultiplier(player, ctx) {
    const { strategy, comp, currentRound, totalRounds, myCounts, urgent } = ctx;
    const pos = player.position;
    const unfilled = comp.unfilledStartingSlots;

    let multiplier;
    let label;

    const dedicated = fillsSlot(pos, unfilled, [SLOT.QB, SLOT.RB, SLOT.WR, SLOT.TE, SLOT.DST, SLOT.K]);
    const flex = fillsSlot(pos, unfilled, [SLOT.FLEX, SLOT.RB_WR, SLOT.WR_TE]);

    if (dedicated !== null && (pos === 'RB' || pos === 'WR')) {
      multiplier = strategy.NEED_STARTING_RB_WR;
      label = 'fills a starting RB/WR slot';
    } else if (flex !== null) {
      multiplier = strategy.NEED_FLEX;
      label = 'fills your FLEX';
    } else if (dedicated !== null) {
      multiplier = strategy.NEED_STARTING_OTHER;
      label = `fills your starting ${pos}`;
    } else if ((pos === 'RB' || pos === 'WR') && comp.benchRbWr < strategy.BENCH_RB_WR_TARGET) {
      multiplier = strategy.NEED_BENCH_RB_WR;
      label = 'adds RB/WR bench depth';
    } else {
      multiplier = strategy.NEED_SURPLUS;
      label = 'depth only';
    }

    // Late-round decay: a fourth good RB in the last rounds is usually a
    // handcuff who never plays, so bench preference relaxes toward neutral.
    const roundsLeft = Math.max(0, totalRounds - currentRound + 1);
    if (label === 'adds RB/WR bench depth' && roundsLeft <= strategy.LATE_ROUND_WINDOW) {
      const decay = roundsLeft / (strategy.LATE_ROUND_WINDOW + 1);
      multiplier = 1 + (multiplier - 1) * decay;
      label = 'bench depth (late-round discount)';
    }

    const cap = strategy.DIMINISHING_RETURNS_AFTER[pos];
    if (cap !== undefined && (myCounts[pos] || 0) >= cap) {
      multiplier *= strategy.DIMINISHING_RETURNS_FACTOR;
      label = `${label}, past ${cap} ${pos}`;
    }

    if (urgent && (dedicated !== null || flex !== null)) {
      multiplier *= strategy.URGENCY_MULTIPLIER;
      label = `must fill ${pos} — running out of picks`;
    }

    return { multiplier, label };
  }

  function buildReason(entry, ctx) {
    const bits = [];
    bits.push(`${entry.player.position}${entry.positionRank} in tier ${entry.tier}`);
    bits.push(`${round1(entry.vor)} VOR`);

    if (entry.needLabel) bits.push(entry.needLabel);

    if (entry.survivalProbability < 0.35) {
      bits.push(`only ${Math.round(entry.survivalProbability * 100)}% to last to pick ${ctx.nextPick}`);
    } else if (entry.survivalProbability > 0.75 && ctx.nextPick) {
      bits.push(`${Math.round(entry.survivalProbability * 100)}% likely to still be there at ${ctx.nextPick}`);
    }

    if (entry.opportunityCost > 5) {
      bits.push(`waiting at ${entry.player.position} costs ~${round1(entry.opportunityCost)} pts`);
    }

    if (entry.injuryStatus !== 'ACTIVE') bits.push(`listed ${entry.injuryStatus}`);
    if (entry.override === 'te-tier-cliff') bits.push('tier cliff overrides the TE gate');
    if (entry.override === 'roster-urgency') bits.push('roster urgency overrides positional order');

    return `${bits.join('; ')}.`;
  }

  function recommend(draftState, playerPool, strategy) {
    const state = draftState;
    const settings = state.settings;
    const playersById = new Map(playerPool.map((p) => [p.id, p]));

    const currentPick = FDADraftState.currentOverallPick(state);
    const nextPick = FDADraftState.nextPickForMe(state);
    const currentRound = FDADraftState.roundOf(state, currentPick);
    const comp = FDADraftState.rosterComposition(state, playersById);

    // Valuation runs over the FULL pool so replacement level stays anchored as
    // the draft depletes positions.
    const { players: valued, replacementByPosition } = FDAVor.buildValuation({
      players: playerPool,
      settings,
      teamCount: state.teamCount,
      strategy,
      projectionOf: (p) => p.projectedPoints
    });

    const available = valued.filter((p) => !state.draftedPlayerIds.has(p.id));

    const byPosition = new Map();
    for (const p of available) {
      if (!byPosition.has(p.position)) byPosition.set(p.position, []);
      byPosition.get(p.position).push(p);
    }

    const opposingRosters = opposingRostersBefore(state, playersById);
    const survivalContext = {
      currentPick,
      nextPick,
      poolSize: playerPool.length,
      opposingRosters
    };

    const survivalById = new Map();
    for (const p of available) {
      survivalById.set(p.id, FDASurvival.survivalProbability(p, survivalContext, strategy));
    }

    const opportunityByPosition = {};
    for (const [position, group] of byPosition) {
      opportunityByPosition[position] = FDASurvival.opportunityCost(group, survivalById);
    }

    const myPlayerIds = state.rostersByTeam.get(state.myTeamId) || [];
    const myPlayers = myPlayerIds.map((id) => playersById.get(id)).filter(Boolean);
    const myCounts = positionCounts(myPlayerIds, playersById);

    const unfilledMandatory = unfilledMandatoryCount(comp.unfilledStartingSlots);
    const urgent = unfilledMandatory >= comp.picksRemaining - strategy.URGENCY_SLACK;

    const teGroup = byPosition.get('TE') || [];
    const teVorEdge = teGroup.length > 1 ? teGroup[0].vor - teGroup[1].vor : Infinity;

    const ctx = {
      strategy, comp, currentRound, totalRounds: state.totalRounds,
      myCounts, myPlayers, settings, urgent, teVorEdge, nextPick
    };

    // VOR goes negative deep in the pool. Shift to a positive scale so need
    // multipliers stay monotonic instead of inverting on negative values.
    const minVor = available.length ? Math.min(...available.map((p) => p.vor)) : 0;
    const shift = minVor < 0 ? -minVor + 1 : 1;

    const scored = [];
    const blocked = [];

    for (const player of available) {
      const constraint = checkConstraints(player, ctx);
      const discount = injuryDiscount(player.injuryStatus, strategy);
      // Discount on the shifted scale, then shift back. Multiplying raw VOR
      // would make a negative value *larger*, promoting injured players to the
      // top of the board once the pool drops below replacement.
      const adjustedVor = (player.vor + shift) * discount - shift;

      const entry = {
        player,
        positionRank: player.positionRank,
        tier: player.tier,
        lastInTier: player.lastInTier,
        projectedPoints: round1(player.projectedPoints),
        vor: round1(player.vor),
        rawVor: player.vor,
        adjustedVor,
        survivalProbability: survivalById.get(player.id) ?? 0,
        opportunityCost: opportunityByPosition[player.position] ?? 0,
        injuryStatus: player.injuryStatus,
        injuryHistoryFlag: null, // populated by enrichment in a later phase
        adpDelta: player.adp > 0 ? round1(currentPick - player.adp) : null,
        override: constraint.override || null
      };

      if (!constraint.allowed) {
        blocked.push({ ...entry, blockedReason: constraint.reason });
        continue;
      }

      const need = needMultiplier(player, ctx);
      entry.needMultiplier = round1(need.multiplier);
      entry.needLabel = need.label;
      entry.finalScore = (adjustedVor + shift) * need.multiplier;
      scored.push(entry);
    }

    scored.sort((a, b) => b.finalScore - a.finalScore);
    const top = scored.slice(0, strategy.TOP_N);
    for (const entry of top) entry.reason = buildReason(entry, ctx);

    // Off-plan value: raw VOR far above the top need-adjusted pick. Surfaced
    // separately and labelled — never silently promoted, never suppressed.
    // Only meaningful while the plan's own pick is still above replacement: a
    // percentage margin inverts once the benchmark goes negative, and deep in
    // the pool there is no steal to surface anyway.
    let offPlanValue = null;
    if (top.length && top[0].rawVor > 0) {
      const benchmark = top[0].rawVor;
      const topIds = new Set(top.map((e) => e.player.id));
      const seenPositions = new Set();
      const candidates = [...scored, ...blocked]
        .filter((e) => !topIds.has(e.player.id))
        .filter((e) => e.rawVor > benchmark * (1 + strategy.OFF_PLAN_VOR_THRESHOLD))
        .sort((a, b) => b.rawVor - a.rawVor)
        // One per position: the second-best DST is the same argument twice.
        .filter((e) => !seenPositions.has(e.player.position) && seenPositions.add(e.player.position))
        .slice(0, strategy.OFF_PLAN_MAX_RESULTS);

      if (candidates.length) {
        offPlanValue = candidates.map((e) => ({
          ...e,
          reason:
            `${e.player.position}${e.positionRank}, ${round1(e.rawVor)} VOR vs ${round1(benchmark)} for your top pick` +
            (e.blockedReason ? ` — breaks your plan (${e.blockedReason})` : ' — off your positional order') +
            '.'
        }));
      }
    }

    // Alerts: tier cliffs at positions you still need.
    const positionalAlerts = [];
    for (const [position, group] of byPosition) {
      if (!group.length) continue;
      const best = group[0];
      const needsPosition =
        fillsSlot(position, comp.unfilledStartingSlots, MANDATORY_SLOTS) !== null ||
        ((position === 'RB' || position === 'WR') &&
          comp.benchRbWr < strategy.BENCH_RB_WR_TARGET);
      if (!needsPosition) continue;

      const survival = survivalById.get(best.id) ?? 0;
      if (best.lastInTier && survival < strategy.TIER_CLIFF_ALERT_MAX_SURVIVAL) {
        positionalAlerts.push({
          position,
          severity: survival < 0.25 ? 'high' : 'medium',
          message:
            `${best.name} is the last ${position} in tier ${best.tier} ` +
            `(${Math.round(survival * 100)}% to reach your next pick)`
        });
      }
    }
    positionalAlerts.sort((a, b) => (a.severity === 'high' ? -1 : 1));

    return {
      top5: top,
      offPlanValue,
      rosterState: {
        filled: myCounts,
        unfilled: comp.unfilledStartingSlots,
        benchDepth: comp.benchDepth,
        benchRbWr: comp.benchRbWr,
        benchTarget: strategy.BENCH_RB_WR_TARGET,
        picksRemaining: comp.picksRemaining,
        totalDrafted: comp.totalDrafted,
        urgent
      },
      positionalAlerts,
      meta: {
        currentPick,
        nextPick,
        currentRound,
        picksUntilMyTurn: FDADraftState.picksUntilMyTurn(state),
        replacementByPosition,
        availableCount: available.length
      }
    };
  }

  root.FDARecommend = { recommend, checkConstraints, needMultiplier, positionCounts };
})(typeof globalThis !== 'undefined' ? globalThis : window);
