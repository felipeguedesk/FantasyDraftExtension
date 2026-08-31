// ESPN proTeamId -> abbreviation. Id 0 is "no team" (free agent / retired).
(function (root) {
  'use strict';

  const ABBREV_BY_ID = {
    0: 'FA', 1: 'ATL', 2: 'BUF', 3: 'CHI', 4: 'CIN', 5: 'CLE', 6: 'DAL',
    7: 'DEN', 8: 'DET', 9: 'GB', 10: 'TEN', 11: 'IND', 12: 'KC', 13: 'LV',
    14: 'LAR', 15: 'MIA', 16: 'MIN', 17: 'NE', 18: 'NO', 19: 'NYG', 20: 'NYJ',
    21: 'PHI', 22: 'ARI', 23: 'PIT', 24: 'LAC', 25: 'SF', 26: 'SEA', 27: 'TB',
    28: 'WSH', 29: 'CAR', 30: 'JAX', 33: 'BAL', 34: 'HOU'
  };

  root.FDANflTeams = {
    ABBREV_BY_ID,
    abbrev: (proTeamId) => ABBREV_BY_ID[proTeamId] || 'FA'
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
