// ADP-based availability model and opportunity cost.
(function (root) {
  'use strict';

  // Draft point is modelled as logistic rather than normal. A normal tail is
  // too thin for this: it says a player with ADP 10 still on the board at pick
  // 40 has essentially no chance of lasting four more picks, when in reality he
  // is falling for a reason and will probably keep falling. The logistic has an
  // exponential tail (constant hazard), which matches how players actually slide,
  // and its conditional form stays numerically stable deep in the tail where a
  // normal underflows to exactly zero.
  const LOGISTIC_SCALE = Math.sqrt(3) / Math.PI; // matches variance to sigma

  function softplus(z) {
    return z > 30 ? z : Math.log1p(Math.exp(z));
  }

  // log P(draft point > x), for a logistic centred at mu.
  function logUpperTail(x, mu, scale) {
    if (scale <= 0) return x >= mu ? -Infinity : 0;
    return -softplus((x - mu) / scale);
  }

  // Variance grows with ADP: round 1 is near-deterministic, round 10 is chaos.
  // A flat sigma would imply an ADP-1.35 player might last to pick 15.
  function adpSigma(adp, strategy) {
    return Math.max(strategy.ADP_SIGMA_FLOOR, strategy.ADP_SIGMA_SLOPE * adp);
  }

  function effectiveAdp(player, poolSize, strategy) {
    if (player.adp > 0) return player.adp;
    return poolSize * strategy.ADP_MISSING_FALLBACK_MULTIPLIER;
  }

  // How badly the teams picking before my next turn want this position.
  // A team with three RBs already is unlikely to take a fourth.
  function opponentDemand(position, opposingRosters, strategy) {
    if (!opposingRosters || !opposingRosters.length) return 1;
    const saturationPoint = strategy.OPPONENT_NEED_SATURATION[position] ?? 2;
    let total = 0;
    for (const roster of opposingRosters) {
      const held = roster[position] || 0;
      total += held >= saturationPoint ? strategy.OPPONENT_SATURATED_DEMAND : 1;
    }
    return total / opposingRosters.length;
  }

  // P(still available at my next pick | still available now).
  // Conditioning matters: a player who has already outlasted his ADP is more
  // likely to keep falling than the unconditional distribution suggests.
  function survivalProbability(player, context, strategy) {
    const { currentPick, nextPick, poolSize, opposingRosters } = context;
    if (nextPick === null || nextPick <= currentPick) return 1;

    const adp = effectiveAdp(player, poolSize, strategy);
    const sigma = adpSigma(adp, strategy);

    const demand = opponentDemand(player.position, opposingRosters, strategy);
    // Soft demand stretches the effective distance to my next pick, so
    // positions nobody needs survive longer.
    const effectiveNext = currentPick + (nextPick - currentPick) * demand;

    const scale = sigma * LOGISTIC_SCALE;
    const logNow = logUpperTail(currentPick, adp, scale);
    const logNext = logUpperTail(effectiveNext, adp, scale);

    return Math.max(0, Math.min(1, Math.exp(logNext - logNow)));
  }

  // Expected VOR of the best player still available at this position when my
  // next turn arrives: sum over players of (their VOR x they survive x everyone
  // better than them is gone).
  function expectedBestVor(positionPlayersDesc, survivalByPlayerId) {
    let expected = 0;
    let allBetterGone = 1;
    for (const p of positionPlayersDesc) {
      const survives = survivalByPlayerId.get(p.id) ?? 0;
      expected += p.vor * survives * allBetterGone;
      allBetterGone *= 1 - survives;
      if (allBetterGone < 1e-6) break;
    }
    return expected;
  }

  // The number that actually drives decisions: what waiting costs at this
  // position. High opportunity cost means take it now.
  function opportunityCost(positionPlayersDesc, survivalByPlayerId) {
    if (!positionPlayersDesc.length) return 0;
    const bestNow = positionPlayersDesc[0].vor;
    return bestNow - expectedBestVor(positionPlayersDesc, survivalByPlayerId);
  }

  root.FDASurvival = {
    logUpperTail,
    adpSigma,
    effectiveAdp,
    opponentDemand,
    survivalProbability,
    expectedBestVor,
    opportunityCost
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
