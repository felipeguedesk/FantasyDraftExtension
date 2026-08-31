// Snapshots to chrome.storage.local so a tab crash or extension reload does not
// cost a re-fetch of 500 players mid-draft, and so a cold start with the API
// down still has something to reason about.
(function (root) {
  'use strict';

  const DRAFT_PREFIX = 'fda.draft.';
  const POOL_PREFIX = 'fda.pool.';
  // Projections are set before the season and do not move during a draft.
  const POOL_MAX_AGE_MS = 12 * 60 * 60 * 1000;

  const draftKey = (leagueId) => `${DRAFT_PREFIX}${leagueId}`;
  const poolKey = (seasonId, leagueId) => `${POOL_PREFIX}${seasonId}.${leagueId}`;

  async function get(key) {
    const bag = await chrome.storage.local.get(key);
    return bag[key] ?? null;
  }

  async function set(key, value) {
    await chrome.storage.local.set({ [key]: value });
  }

  // Only the fields needed to rebuild state. Storing the whole state object
  // would drag Sets and Maps through JSON, which do not survive the trip.
  async function saveDraft(leagueId, { picks, myTeamId, settings }) {
    await set(draftKey(leagueId), {
      savedAt: Date.now(),
      myTeamId: myTeamId ?? null,
      settings: settings ?? null,
      picks: (picks || []).map((p) => ({
        playerId: p.playerId,
        teamId: p.teamId,
        round: p.round,
        roundPick: p.roundPick,
        overall: p.overall,
        keeper: !!p.keeper,
        autoDraft: !!p.autoDraft
      }))
    });
  }

  const loadDraft = (leagueId) => get(draftKey(leagueId));

  async function savePool(seasonId, leagueId, players) {
    await set(poolKey(seasonId, leagueId), { savedAt: Date.now(), players });
  }

  async function loadPool(seasonId, leagueId, maxAgeMs = POOL_MAX_AGE_MS) {
    const cached = await get(poolKey(seasonId, leagueId));
    if (!cached || !Array.isArray(cached.players) || !cached.players.length) return null;
    if (Date.now() - (cached.savedAt || 0) > maxAgeMs) return null;
    return cached;
  }

  async function clearLeague(leagueId, seasonId) {
    await chrome.storage.local.remove([draftKey(leagueId), poolKey(seasonId, leagueId)]);
  }

  root.FDAPersist = {
    POOL_MAX_AGE_MS,
    saveDraft,
    loadDraft,
    savePool,
    loadPool,
    clearLeague
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
