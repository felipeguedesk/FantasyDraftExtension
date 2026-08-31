// Replacement levels, Value Over Replacement, and tier detection.
(function (root) {
  'use strict';

  const SLOT_FOR_POSITION = { QB: 0, RB: 2, WR: 4, TE: 6, DST: 16, K: 17 };
  const FLEX_SLOTS = [23, 3, 5]; // FLEX, RB/WR, WR/TE

  function mean(xs) {
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
  }

  function stdev(xs) {
    if (xs.length < 2) return 0;
    const m = mean(xs);
    return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
  }

  // How many starters of this position the league collectively fields, counting
  // a proportional share of flex slots. This is what sets replacement level:
  // the last player at the position expected to be started league-wide.
  function replacementRank(position, slotCounts, teamCount, strategy) {
    const dedicated = slotCounts[SLOT_FOR_POSITION[position]] || 0;
    const flexTotal = FLEX_SLOTS.reduce((sum, id) => sum + (slotCounts[id] || 0), 0);
    const share = strategy.FLEX_USAGE_SHARE[position] || 0;
    const perTeam = dedicated + flexTotal * share;
    return Math.max(1, Math.round(perTeam * teamCount));
  }

  // Replacement points = projection of the player sitting at the replacement
  // rank. Uses the FULL pool (drafted included) so the baseline doesn't drift
  // upward as the draft depletes the position.
  function replacementPoints(sortedPoints, rank, strategy) {
    if (!sortedPoints.length) return 0;
    if (sortedPoints.length < strategy.MIN_POSITION_SAMPLE) {
      return sortedPoints[sortedPoints.length - 1];
    }
    const index = Math.min(rank - 1, sortedPoints.length - 1);
    return sortedPoints[index];
  }

  // Tier breaks where the VOR gap to the next player exceeds
  // mean(gap) + TIER_BREAK_SIGMA * stdev(gap) for that position.
  function assignTiers(playersDesc, strategy) {
    if (playersDesc.length < strategy.TIER_MIN_SAMPLE) {
      playersDesc.forEach((p) => {
        p.tier = 1;
        p.lastInTier = false;
      });
      if (playersDesc.length) playersDesc[playersDesc.length - 1].lastInTier = true;
      return playersDesc;
    }

    const gaps = [];
    for (let i = 0; i < playersDesc.length - 1; i++) {
      gaps.push(playersDesc[i].vor - playersDesc[i + 1].vor);
    }
    const threshold = mean(gaps) + strategy.TIER_BREAK_SIGMA * stdev(gaps);

    let tier = 1;
    for (let i = 0; i < playersDesc.length; i++) {
      playersDesc[i].tier = tier;
      const gap = i < gaps.length ? gaps[i] : Infinity;
      const isBreak = gap > threshold;
      playersDesc[i].lastInTier = isBreak || i === playersDesc.length - 1;
      if (isBreak) tier++;
    }
    return playersDesc;
  }

  // Builds the valuation layer over the whole pool. Pure: no mutation of input.
  function buildValuation({ players, settings, teamCount, strategy, projectionOf }) {
    const byPosition = new Map();
    for (const p of players) {
      if (!byPosition.has(p.position)) byPosition.set(p.position, []);
      byPosition.get(p.position).push(p);
    }

    const replacementByPosition = {};
    const valued = [];

    for (const [position, group] of byPosition) {
      const withPoints = group.map((p) => ({
        player: p,
        projectedPoints: projectionOf(p)
      }));

      const sortedPoints = withPoints
        .map((x) => x.projectedPoints)
        .sort((a, b) => b - a);

      const rank = replacementRank(position, settings.slotCounts, teamCount, strategy);
      const baseline = replacementPoints(sortedPoints, rank, strategy);
      replacementByPosition[position] = { rank, points: baseline };

      const scored = withPoints
        .map((x) => ({
          ...x.player,
          projectedPoints: x.projectedPoints,
          vor: x.projectedPoints - baseline
        }))
        .sort((a, b) => b.vor - a.vor);

      scored.forEach((p, i) => {
        p.positionRank = i + 1;
      });
      assignTiers(scored, strategy);
      valued.push(...scored);
    }

    return {
      players: valued.sort((a, b) => b.vor - a.vor),
      replacementByPosition
    };
  }

  root.FDAVor = {
    SLOT_FOR_POSITION,
    FLEX_SLOTS,
    mean,
    stdev,
    replacementRank,
    replacementPoints,
    assignTiers,
    buildValuation
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
