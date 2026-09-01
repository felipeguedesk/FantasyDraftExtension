// Paste this into the DevTools console of a live ESPN draft room (top frame,
// fantasy.espn.com). It runs in the page, so it inherits the espn_s2/SWID
// cookies the same way the extension does.
//
// It answers one question: where, in a draft that is actually running, does
// ESPN put the picks that have already happened? mDraftDetail has been observed
// returning nothing but placeholder slots mid-draft, which leaves the panel
// convinced the draft has not started.
//
// Output is shape and counts only — no player names, no member GUIDs.
(async () => {
  const u = new URL(location.href);
  const leagueId = u.searchParams.get('leagueId');
  const seasonId = u.searchParams.get('seasonId') || new Date().getFullYear();
  const url =
    `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${seasonId}` +
    `/segments/0/leagues/${leagueId}?view=mDraftDetail&view=mTeam&view=mRoster`;

  const res = await fetch(url, { credentials: 'include' });
  const json = await res.json().catch(() => ({}));

  const detail = json.draftDetail || {};
  const picks = Array.isArray(detail.picks) ? detail.picks : [];
  const made = picks.filter((p) => p && p.playerId > 0);
  const teams = Array.isArray(json.teams) ? json.teams : [];

  const report = {
    httpStatus: res.status,
    topLevelKeys: Object.keys(json),
    draftDetailKeys: Object.keys(detail),
    inProgress: detail.inProgress,
    drafted: detail.drafted,
    pickSlots: picks.length,
    picksWithAPlayer: made.length,
    // Field names matter as much as counts: roundId/roundPickNumber/
    // overallPickNumber are assumed, not confirmed.
    samplePickKeys: picks[0] ? Object.keys(picks[0]) : null,
    sampleMadePick: made[0] || null,
    samplePlaceholderPick: picks.find((p) => p && p.playerId <= 0) || null,
    rosterSizes: teams.map((t) => ({
      teamId: t.id,
      entries: ((t.roster || {}).entries || []).length
    })),
    sampleRosterEntryKeys:
      teams[0] && (teams[0].roster || {}).entries && teams[0].roster.entries[0]
        ? Object.keys(teams[0].roster.entries[0])
        : null
  };

  const out = JSON.stringify(report, null, 1);
  try {
    copy(out);
    console.log('FDA api-probe: copied to clipboard,', out.length, 'chars');
  } catch {
    console.log('FDA api-probe: clipboard unavailable, copy the object below');
  }
  console.log(report);
  return report;
})();
