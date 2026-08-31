// ALL tunable strategy constants live here. Nothing else in engine/ hardcodes a weight.
// Tune between mock drafts by editing this file only.
(function (root) {
  'use strict';

  const STRATEGY = {
    // ---------------------------------------------------------------------
    // Replacement level (vor.js)
    // ---------------------------------------------------------------------

    // Share of FLEX slots each position is expected to occupy league-wide.
    // Historical usage: flex is overwhelmingly RB/WR, TE only when elite.
    // Used to extend replacement rank beyond dedicated starting slots.
    FLEX_USAGE_SHARE: { RB: 0.45, WR: 0.50, TE: 0.05 },

    // Positions that can occupy a FLEX slot.
    FLEX_ELIGIBLE: ['RB', 'WR', 'TE'],

    // If a position has fewer players than its replacement rank, fall back to
    // the worst available projection rather than producing a negative baseline.
    MIN_POSITION_SAMPLE: 3,

    // ---------------------------------------------------------------------
    // Tiers (vor.js)
    // ---------------------------------------------------------------------

    // A tier break occurs where the VOR gap to the next player exceeds
    // mean(gap) + TIER_BREAK_SIGMA * stdev(gap) for that position.
    TIER_BREAK_SIGMA: 1.2,

    // Positions need at least this many players for tier detection to mean
    // anything; below it everyone lands in tier 1.
    TIER_MIN_SAMPLE: 6,

    // ---------------------------------------------------------------------
    // Survival model (survival.js)
    // ---------------------------------------------------------------------

    // ESPN exposes no ADP standard deviation, so we model it.
    // A FLAT sigma is wrong: it implies a player with ADP 1.35 might last to
    // pick 15, and could be drafted at pick -6. Real ADP variance is tight at
    // the top and widens deeper into the draft.
    ADP_SIGMA_FLOOR: 1.5,
    ADP_SIGMA_SLOPE: 0.35, // sigma = max(FLOOR, SLOPE * ADP)

    // Players with no ADP get parked behind the pool so they never look like
    // steals purely because data is missing.
    ADP_MISSING_FALLBACK_MULTIPLIER: 1.25,

    // Opposing teams that already have this many at a position are less likely
    // to take another; scales that team's demand for the position.
    OPPONENT_NEED_SATURATION: { RB: 3, WR: 3, TE: 1, QB: 1, K: 1, DST: 1 },
    OPPONENT_SATURATED_DEMAND: 0.35, // multiplier once saturated

    // ---------------------------------------------------------------------
    // Roster need weighting (recommend.js)
    // ---------------------------------------------------------------------

    // Ordering here is the whole strategy. The non-obvious, deliberate rule:
    // NEED_BENCH_RB_WR > NEED_STARTING_OTHER. A fourth good RB beats a
    // mediocre starting QB, because the QB6-to-QB14 weekly gap is small and
    // waiver-replaceable while the RB4-to-streamer gap is large, and RB is
    // where injuries force your hand.
    NEED_STARTING_RB_WR: 2.4,   // unfilled dedicated RB or WR starting slot
    NEED_FLEX: 2.0,             // unfilled FLEX slot
    NEED_BENCH_RB_WR: 1.6,      // RB/WR bench depth below target
    NEED_STARTING_OTHER: 1.15,  // unfilled TE / QB / DST / K starting slot
    NEED_SURPLUS: 0.75,         // position already covered

    // Target RB/WR bench pieces before depth stops being a priority.
    BENCH_RB_WR_TARGET: 4,

    // Diminishing returns past roughly 5 RB + 5 WR rostered.
    DIMINISHING_RETURNS_AFTER: { RB: 5, WR: 5 },
    DIMINISHING_RETURNS_FACTOR: 0.55,

    // ---------------------------------------------------------------------
    // Late-round behaviour
    // ---------------------------------------------------------------------

    // Within this many rounds of the end, RB/WR bench preference decays toward
    // neutral. At pick 14.8 a "fourth good RB" is usually a handcuff who never
    // plays, and taking your only QB then is worse than taking him in round 11.
    LATE_ROUND_WINDOW: 3,

    // If unfilled mandatory starting slots >= remaining picks, filling them
    // becomes urgent regardless of positional preference — this is what stops
    // the draft ending with no QB.
    URGENCY_MULTIPLIER: 6.0,
    URGENCY_SLACK: 1, // start applying urgency this many picks early

    // ---------------------------------------------------------------------
    // Hard constraints (2d). Violated only via the off-plan value override.
    // ---------------------------------------------------------------------

    // Kicker: final round only.
    K_ROUNDS_FROM_END: 0,
    // Defense: last two rounds only.
    DST_ROUNDS_FROM_END: 1,

    // QB gate: no QB until starting RB/WR/FLEX slots are filled AND this many
    // RB/WR bench pieces are rostered.
    QB_REQUIRES_BENCH_RB_WR: 2,
    // TE gate: same shape, one round softer.
    TE_REQUIRES_BENCH_RB_WR: 1,

    // Never a second QB in a 1-QB league; never a second TE unless the first
    // is OUT or INJURY_RESERVE.
    SECOND_TE_ALLOWED_IF_INJURED: ['OUT', 'INJURY_RESERVE'],

    // TE tier-cliff carve-out. TE is the most tier-cliffed position in fantasy:
    // the top 2-3 are separated from TE8+ by more than the RB2/RB4 gap the
    // strategy is protecting. A blanket gate would systematically miss the only
    // edge at the position, so a tier cliff may override the gate.
    TE_TIER_CLIFF_OVERRIDE: true,
    TE_CLIFF_MAX_TIER: 2,       // only tiers 1-2 qualify
    TE_CLIFF_MIN_VOR_EDGE: 15,  // and only with this much VOR over the next TE

    // ---------------------------------------------------------------------
    // Off-plan value override (2e)
    // ---------------------------------------------------------------------

    // Surfaced separately when raw VOR exceeds the top need-adjusted pick's raw
    // VOR by this fraction. Never silently promoted into the top 5.
    OFF_PLAN_VOR_THRESHOLD: 0.25,
    OFF_PLAN_MAX_RESULTS: 2,

    // ---------------------------------------------------------------------
    // Injury handling (2f)
    // ---------------------------------------------------------------------

    // Projection discount by current status. Injury HISTORY is deliberately
    // NOT folded into the score — it is surfaced as a badge instead, because
    // recurring soft-tissue injuries mean something different for a 29-year-old
    // RB than a 24-year-old WR, and that judgment belongs to the drafter.
    INJURY_DISCOUNT: {
      ACTIVE: 1.0,
      QUESTIONABLE: 0.95,
      DOUBTFUL: 0.80,
      OUT: 0.60,
      INJURY_RESERVE: 0.35,
      SUSPENSION: 0.70
    },

    // ---------------------------------------------------------------------
    // Output
    // ---------------------------------------------------------------------

    TOP_N: 5,

    // Alert when the last player in a tier at a needed position is about to go.
    TIER_CLIFF_ALERT_MAX_SURVIVAL: 0.5
  };

  root.FDAStrategy = STRATEGY;
})(typeof globalThis !== 'undefined' ? globalThis : window);
