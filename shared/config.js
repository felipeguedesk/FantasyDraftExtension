// League configuration, shared by the content script and the popup.
// Supports multiple leagues so a mock in one league doesn't clobber another's state.
(function (root) {
  'use strict';

  const STORAGE_KEY = 'fda.config.v1';
  const DEFAULT_SEASON = 2026;

  function emptyConfig() {
    return { activeLeagueId: null, leagues: {} };
  }

  function normalize(raw) {
    const cfg = emptyConfig();
    if (!raw || typeof raw !== 'object') return cfg;
    const leagues = raw.leagues && typeof raw.leagues === 'object' ? raw.leagues : {};
    for (const [id, v] of Object.entries(leagues)) {
      if (!/^\d+$/.test(id) || !v || typeof v !== 'object') continue;
      cfg.leagues[id] = {
        leagueId: id,
        seasonId: Number.isInteger(v.seasonId) ? v.seasonId : DEFAULT_SEASON,
        label: typeof v.label === 'string' ? v.label : '',
        myTeamId: Number.isInteger(v.myTeamId) ? v.myTeamId : null,
        addedAt: Number.isFinite(v.addedAt) ? v.addedAt : Date.now(),
        lastSeenAt: Number.isFinite(v.lastSeenAt) ? v.lastSeenAt : null,
        verified: v.verified && typeof v.verified === 'object' ? v.verified : null
      };
    }
    const active = raw.activeLeagueId;
    cfg.activeLeagueId =
      typeof active === 'string' && cfg.leagues[active] ? active : null;
    // Single saved league is unambiguous — treat it as active so the user
    // never has to make a redundant selection.
    if (!cfg.activeLeagueId) {
      const ids = Object.keys(cfg.leagues);
      if (ids.length === 1) cfg.activeLeagueId = ids[0];
    }
    return cfg;
  }

  async function load() {
    const got = await chrome.storage.local.get(STORAGE_KEY);
    return normalize(got && got[STORAGE_KEY]);
  }

  async function save(cfg) {
    const clean = normalize(cfg);
    await chrome.storage.local.set({ [STORAGE_KEY]: clean });
    return clean;
  }

  function upsertLeague(cfg, entry) {
    const next = normalize(cfg);
    const id = String(entry.leagueId || '').trim();
    if (!/^\d+$/.test(id)) throw new Error('League ID must be numeric');
    const prev = next.leagues[id] || {};
    next.leagues[id] = {
      leagueId: id,
      seasonId: Number.isInteger(entry.seasonId) ? entry.seasonId : (prev.seasonId || DEFAULT_SEASON),
      label: entry.label !== undefined ? String(entry.label) : (prev.label || ''),
      myTeamId: entry.myTeamId !== undefined
        ? (Number.isInteger(entry.myTeamId) ? entry.myTeamId : null)
        : (prev.myTeamId ?? null),
      addedAt: prev.addedAt || Date.now(),
      lastSeenAt: entry.lastSeenAt !== undefined ? entry.lastSeenAt : (prev.lastSeenAt ?? null),
      verified: entry.verified !== undefined ? entry.verified : (prev.verified || null)
    };
    if (!next.activeLeagueId) next.activeLeagueId = id;
    return next;
  }

  function removeLeague(cfg, leagueId) {
    const next = normalize(cfg);
    delete next.leagues[String(leagueId)];
    if (next.activeLeagueId === String(leagueId)) next.activeLeagueId = null;
    return normalize(next);
  }

  function getActive(cfg) {
    const n = normalize(cfg);
    return n.activeLeagueId ? n.leagues[n.activeLeagueId] : null;
  }

  // ESPN puts leagueId/seasonId/teamId in the query string on league, draft,
  // and mock draft URLs. Mock lobbies have no leagueId until the room opens.
  function parseUrl(url) {
    let u;
    try {
      u = new URL(url);
    } catch {
      return null;
    }
    if (u.hostname !== 'fantasy.espn.com') return null;
    const q = u.searchParams;
    const leagueId = q.get('leagueId');
    const seasonId = q.get('seasonId');
    const teamId = q.get('teamId');
    const path = u.pathname.toLowerCase();
    return {
      leagueId: leagueId && /^\d+$/.test(leagueId) ? leagueId : null,
      seasonId: seasonId && /^\d{4}$/.test(seasonId) ? Number(seasonId) : DEFAULT_SEASON,
      teamId: teamId && /^\d+$/.test(teamId) ? Number(teamId) : null,
      isDraftRoom: path.includes('/draft') || path.includes('mockdraft'),
      path: u.pathname
    };
  }

  root.FDAConfig = {
    STORAGE_KEY,
    DEFAULT_SEASON,
    emptyConfig,
    normalize,
    load,
    save,
    upsertLeague,
    removeLeague,
    getActive,
    parseUrl
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
