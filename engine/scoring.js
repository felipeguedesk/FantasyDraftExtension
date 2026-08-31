// League scoring rules -> projected points.
//
// Verified empirically: ESPN's `appliedTotal` is ALREADY scored for the league
// that requested it (the same player projects 364.98 under PPR and 297.08 under
// standard, a delta equal to his projected receptions). So the normal path uses
// appliedTotal directly. This module exists to PROVE that per league, and to
// recompute from component stats when it doesn't hold.
(function (root) {
  'use strict';

  // Recompute a projection from raw component stats and the league's scoring
  // coefficients. statId -> points, summed over the projected stat map.
  function computeFromComponents(projectedStats, scoringItems) {
    if (!projectedStats || !scoringItems) return 0;
    let total = 0;
    for (const [statId, value] of Object.entries(projectedStats)) {
      const coefficient = scoringItems[Number(statId)];
      if (typeof coefficient !== 'number' || typeof value !== 'number') continue;
      total += coefficient * value;
    }
    return total;
  }

  // Compare ESPN's appliedTotal against our own recomputation across a sample.
  // A large divergence means the league has rules we aren't modelling, and the
  // panel should say so rather than silently trusting either number.
  function verifyScoring(players, scoringItems, { sampleSize = 40, tolerance = 0.05 } = {}) {
    const sample = players
      .filter((p) => p.projectedPoints > 0 && Object.keys(p.projectedStats || {}).length)
      .slice(0, sampleSize);

    if (!sample.length) {
      return { ok: false, reason: 'no-sample', checked: 0, agreement: 0, worst: null };
    }

    let agree = 0;
    let worst = null;
    for (const p of sample) {
      const recomputed = computeFromComponents(p.projectedStats, scoringItems);
      const denominator = Math.abs(p.projectedPoints) || 1;
      const relative = Math.abs(recomputed - p.projectedPoints) / denominator;
      if (relative <= tolerance) agree++;
      if (!worst || relative > worst.relative) {
        worst = { name: p.name, espn: p.projectedPoints, recomputed, relative };
      }
    }

    const agreement = agree / sample.length;
    return {
      ok: agreement >= 0.8,
      reason: agreement >= 0.8 ? 'match' : 'divergent',
      checked: sample.length,
      agreement,
      worst
    };
  }

  // Returns the projection to feed the engine. Prefers appliedTotal; falls back
  // to recomputation only when verification says appliedTotal can't be trusted.
  function projectedPointsFor(player, scoringItems, trustAppliedTotal) {
    if (trustAppliedTotal && player.projectedPoints > 0) return player.projectedPoints;
    const recomputed = computeFromComponents(player.projectedStats, scoringItems);
    return recomputed > 0 ? recomputed : player.projectedPoints;
  }

  root.FDAScoring = { computeFromComponents, verifyScoring, projectedPointsFor };
})(typeof globalThis !== 'undefined' ? globalThis : window);
