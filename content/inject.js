// Entry point: resolve the league, sync read-only state, render the overlay.
// Nothing is ever clicked in the ESPN page and the page is never reloaded.
(function () {
  'use strict';

  const {
    FDAConfig, FDAApi, FDADraftState, FDALog, FDAPersist, FDADomObserver,
    FDAStrategy, FDAScoring, FDARecommend, FDAPanel
  } = globalThis;

  const MIN_POLL_MS = 3000;
  const MAX_BACKOFF_MS = 30000;
  const UI_STATE_KEY = 'fda.ui.v1';
  // A position filter needs more than five candidates to slice from.
  const FILTER_POOL_SIZE = 80;

  const runtime = {
    league: null,
    settings: null,
    players: [],
    playersById: new Map(),
    state: null,
    timer: null,
    backoffMs: 0,
    stopped: false,
    lastError: null,
    loggedPickShape: false,
    // ESPN's read API returns nothing but placeholder picks while a draft is
    // running, so for that whole window the DOM is the only record there is.
    apiBlind: false,
    loggedApiBlind: false,
    notice: null,
    playerIndex: null,
    domEnabled: false,
    domClock: null,
    // Picks the user recorded by hand, replayed after every API sync until the
    // API confirms them. The API stays authoritative for everything else.
    manualPlayerIds: new Set()
  };

  const log = (...a) => FDALog.info(...a);
  const warn = (...a) => FDALog.warn(...a);

  // ESPN stores the logged-in user's SWID as a readable cookie; matching it
  // against team owners identifies my team without asking for it.
  function swidFromCookie() {
    const m = document.cookie.match(/(?:^|;\s*)SWID=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  async function resolveLeague() {
    const cfg = await FDAConfig.load();
    const fromUrl = FDAConfig.parseUrl(location.href);

    if (fromUrl && fromUrl.leagueId) {
      const known = cfg.leagues[fromUrl.leagueId];
      // Auto-save on first visit so a new draft room needs zero setup.
      const next = FDAConfig.upsertLeague(cfg, {
        leagueId: fromUrl.leagueId,
        seasonId: fromUrl.seasonId,
        myTeamId: known?.myTeamId ?? fromUrl.teamId ?? undefined,
        lastSeenAt: Date.now()
      });
      next.activeLeagueId = fromUrl.leagueId;
      await FDAConfig.save(next);
      if (!known) log(`Detected and saved new league ${fromUrl.leagueId}`);
      return FDAConfig.getActive(next);
    }

    const active = FDAConfig.getActive(cfg);
    if (active) log(`Using saved league ${active.leagueId}`);
    return active;
  }

  async function detectMyTeamId(league) {
    if (Number.isInteger(league.myTeamId)) return league.myTeamId;

    const swid = swidFromCookie();
    try {
      const { teams } = await FDAApi.fetchTeams(league.seasonId, league.leagueId);
      if (swid) {
        const mine = teams.find((t) => t.owners.includes(swid));
        if (mine) {
          log(`Auto-detected your team: ${mine.name} (id ${mine.id})`);
          const cfg = await FDAConfig.load();
          await FDAConfig.save(
            FDAConfig.upsertLeague(cfg, { leagueId: league.leagueId, myTeamId: mine.id })
          );
          return mine.id;
        }
      }
      warn(
        'Could not auto-detect your team. Set it in the extension popup. Teams:',
        teams.map((t) => `${t.id}=${t.name}`).join(', ')
      );
    } catch (e) {
      warn('Team lookup failed:', e.message);
    }
    return null;
  }

  function reportSettingsMismatch(settings) {
    const scoring = FDAApi.scoringLabel(settings);
    log(
      `League "${settings.leagueName}" | ${settings.teamCount} teams | ${scoring} ` +
        `(receptions = ${settings.receptionPoints} pts) | ${settings.draft.type}`
    );
    if (settings.draft.type !== 'SNAKE') {
      warn(`Draft type is ${settings.draft.type}, not SNAKE. Pick math assumes snake.`);
    }
    const starting = FDADraftState.startingSlots(settings.slotCounts);
    log(
      'Starting slots:',
      Object.entries(starting).map(([id, n]) => `slot${id}x${n}`).join(' '),
      `| bench ${settings.benchSlots} | ${FDADraftState.rosterSize(settings.slotCounts)} rounds`
    );
  }

  function logState(delta) {
    const s = runtime.state;
    const current = FDADraftState.currentOverallPick(s);
    const until = FDADraftState.picksUntilMyTurn(s);
    const next = FDADraftState.nextPickForMe(s);

    for (const pick of delta.added) {
      const p = runtime.playersById.get(pick.playerId);
      log(
        `Pick ${pick.overall} (R${pick.round}.${pick.roundPick}) team ${pick.teamId}: ` +
          `${p ? `${p.name} ${p.position}` : `unknown player ${pick.playerId}`}`
      );
    }
    if (delta.removed.length) {
      warn('Reconciled away (API disagreed with local state):', delta.removed);
    }

    const comp = FDADraftState.rosterComposition(s, runtime.playersById);
    log(
      `On the clock: pick ${current} (R${FDADraftState.roundOf(s, current)}) | ` +
        (next === null
          ? 'no picks left for you'
          : `your next: ${next} (${until} away)`) +
        ` | your roster ${comp.totalDrafted}/${s.totalRounds}` +
        ` | RB/WR bench ${comp.benchRbWr}`
    );
  }

  // ---- rendering ----

  // One pick of disagreement is just the DOM being ahead of the API, which is
  // the whole point of watching it. Two or more means something is wrong.
  const DRIFT_TOLERANCE = 2;

  // Read live rather than cached from a mutation burst: React updates the timer
  // text through characterData, which the observer deliberately does not watch,
  // so a cached reading could be minutes old and invent drift that is not there.
  function driftPicks() {
    if (!runtime.state || !runtime.domEnabled) return null;
    runtime.domClock = FDADomObserver.readClock(runtime.state.teamCount);

    // With no API to disagree with, the clock is not a cross-check — it is the
    // only thing that knows where the draft is, so it drives the counter and
    // there is no drift left to report.
    runtime.state.observedPick = runtime.apiBlind ? runtime.domClock.currentPick : null;

    if (!runtime.domClock.currentPick || runtime.apiBlind) return null;
    return runtime.domClock.currentPick - FDADraftState.currentOverallPick(runtime.state);
  }

  function health(drift) {
    const stale = runtime.state && runtime.state.lastSyncAt
      ? Date.now() - runtime.state.lastSyncAt > MIN_POLL_MS * 4
      : true;

    const dom = runtime.domEnabled
      ? FDADomObserver.health()
      : { status: 'off', detail: 'DOM observation not started; API is the only source' };

    if (drift !== null && Math.abs(drift) >= DRIFT_TOLERANCE && dom.status !== 'bad') {
      dom.status = 'warn';
      dom.detail =
        `ESPN shows pick ${runtime.domClock.currentPick}, we have ` +
        `${FDADraftState.currentOverallPick(runtime.state)} — ${Math.abs(drift)} pick(s) out of sync.`;
    }

    const blind = runtime.apiBlind && !runtime.lastError && !stale;

    return {
      api: runtime.lastError ? 'down' : stale ? 'stale' : blind ? 'blind' : 'ok',
      apiStatus: runtime.lastError ? 'bad' : stale || blind ? 'warn' : 'ok',
      apiDetail:
        runtime.lastError ||
        (blind ? 'ESPN publishes no picks while a draft runs — the board is the source' : ''),
      dom: dom.status === 'ok' ? 'ok' : dom.status,
      domStatus: dom.status === 'ok' ? 'ok' : dom.status === 'bad' ? 'bad' : 'warn',
      domDetail: dom.detail,
      lastSync: runtime.state && runtime.state.lastSyncAt
        ? new Date(runtime.state.lastSyncAt).toLocaleTimeString()
        : null
    };
  }

  // The DOM sees a pick a beat before mDraftDetail does, and during a live
  // draft it sees them when nothing else does. A false positive is corrected by
  // the first API sync that carries real picks — which, for a draft in
  // progress, means once it is over.
  function onDomPicks(domPicks) {
    if (!runtime.state) return;
    const state = runtime.state;
    const fresh = domPicks.filter(
      (p) => p.overall && !state.draftedPlayerIds.has(p.playerId)
    );
    if (!fresh.length) return;

    const picks = fresh.map((p) => ({
      playerId: p.playerId,
      teamId: FDADraftState.teamAtPick(state.pickOrder, p.overall),
      round: p.round,
      roundPick: p.roundPick,
      overall: p.overall,
      keeper: false,
      autoDraft: false
    }));

    FDADraftState.applyPicks(state, picks, 'dom');
    for (const p of picks) {
      const player = runtime.playersById.get(p.playerId);
      FDALog.debug(`DOM ahead of API: pick ${p.overall} ${player ? player.name : p.playerId}`);
    }
    render(activeFilter);
  }

  function startDomObserver() {
    if (runtime.domEnabled) return;
    try {
      FDADomObserver.start({
        getIndex: () => runtime.playerIndex,
        getTeamCount: () => (runtime.state ? runtime.state.teamCount : 0),
        onPicks: onDomPicks
      });
      runtime.domEnabled = true;
    } catch (e) {
      warn('DOM observer failed to start:', e.message);
    }
  }

  function computeRecommendation(filterPosition) {
    if (!runtime.state || !runtime.players.length) return null;

    if (!filterPosition) {
      return FDARecommend.recommend(runtime.state, runtime.players, FDAStrategy);
    }

    // Widen the slice, then narrow to the position. Filtering the pool itself
    // would move replacement level and silently change every VOR on screen.
    const wide = FDARecommend.recommend(runtime.state, runtime.players, {
      ...FDAStrategy,
      TOP_N: FILTER_POOL_SIZE
    });
    wide.top5 = wide.top5
      .filter((e) => e.player.position === filterPosition)
      .slice(0, FDAStrategy.TOP_N);
    return wide;
  }

  function render(filterPosition) {
    if (!FDAPanel) return;
    let recommendation = null;
    try {
      recommendation = computeRecommendation(filterPosition);
    } catch (e) {
      warn('Recommendation failed:', e.message);
      runtime.notice = `Recommendations unavailable: ${e.message}`;
    }

    // ESPN's own "On the Clock: Pick N" is an independent reading of where the
    // draft is. Disagreeing with it means every recommendation below is being
    // made for the wrong turn — the worst way for this thing to fail, and not
    // something to leave in a tooltip nobody hovers on a 30-second clock.
    const drift = driftPicks();
    const driftNotice =
      drift !== null && Math.abs(drift) >= DRIFT_TOLERANCE
        ? `Out of sync with ESPN by ${Math.abs(drift)} picks — check the board before you pick.`
        : null;

    // When the API is blind we know where the draft is but only who was taken
    // while the board was on screen. Naming that gap is the honest thing to do,
    // and unlike the drift banner it comes with something to act on.
    const unseen =
      runtime.apiBlind && runtime.state
        ? FDADraftState.currentOverallPick(runtime.state) - 1 - runtime.state.picks.length
        : 0;

    FDAPanel.update({
      recommendation,
      slotCounts: runtime.settings ? runtime.settings.slotCounts : {},
      totalRounds: runtime.state ? runtime.state.totalRounds : 0,
      health: health(drift),
      notice: runtime.notice,
      warning:
        driftNotice ||
        (unseen >= DRIFT_TOLERANCE
          ? `${unseen} earlier picks aren't visible to the panel — open ESPN's Board tab once ` +
            `so it can read them, or some players listed below are already gone.`
          : null)
    });
  }

  let activeFilter = null;

  async function mountPanel() {
    const stored = await chrome.storage.local.get(UI_STATE_KEY);
    const ui = stored[UI_STATE_KEY] || {};

    FDAPanel.mount({
      onRefresh: () => {
        if (runtime.timer) clearTimeout(runtime.timer);
        runtime.backoffMs = 0;
        syncPicks();
      },
      onFilter: (position) => {
        activeFilter = position;
        render(activeFilter);
      },
      onMarkDrafted: (playerId) => {
        runtime.manualPlayerIds.add(playerId);
        applyManualPicks();
        render(activeFilter);
      },
      // Lazy: the narrative is worth a request only for a player being read.
      onExpand: (playerId) => {
        FDAApi.fetchInjuryNarrative(playerId).then((items) => {
          FDAPanel.setNarrative(playerId, items);
        });
      },
      onMove: (position) => {
        chrome.storage.local.set({ [UI_STATE_KEY]: { ...ui, position } });
      },
      onCollapse: (collapsed) => {
        chrome.storage.local.set({ [UI_STATE_KEY]: { ...ui, collapsed } });
      }
    });

    if (ui.position) FDAPanel.setPosition(ui.position);
    if (ui.collapsed) document.getElementById(FDAPanel.PANEL_ID).classList.add('fda-collapsed');
  }

  // Manual entries are layered on top of the API view, never merged into it.
  function applyManualPicks() {
    if (!runtime.manualPlayerIds.size || !runtime.state) return;
    const picks = [];
    let overall = FDADraftState.currentOverallPick(runtime.state);

    for (const playerId of runtime.manualPlayerIds) {
      if (runtime.state.draftedPlayerIds.has(playerId)) {
        runtime.manualPlayerIds.delete(playerId);
        continue;
      }
      picks.push({
        playerId,
        teamId: FDADraftState.teamAtPick(runtime.state.pickOrder, overall),
        round: FDADraftState.roundOf(runtime.state, overall),
        roundPick: 0,
        overall: overall++,
        keeper: false,
        autoDraft: false
      });
    }
    if (picks.length) FDADraftState.applyPicks(runtime.state, picks, 'manual');
  }

  // Rosters say who a team has, never in what order it took them — ESPN sorts
  // them by lineup slot. So a team's nth roster player is filed against that
  // team's nth pick, which puts the draft at the right depth and every player
  // on the right team, but gets the order within a team wrong. That is the
  // whole cost of being able to see a live draft at all.
  function picksFromRosters(state, rosters) {
    const picks = [];
    for (const { teamId, playerIds } of rosters || []) {
      const slot = state.pickOrder.indexOf(teamId) + 1;
      if (!slot) continue;
      playerIds.forEach((playerId, i) => {
        picks.push({
          playerId,
          teamId,
          round: i + 1,
          roundPick: 0,
          overall: FDADraftState.overallForRound(state.pickOrder, slot, i + 1),
          keeper: false,
          autoDraft: false
        });
      });
    }
    return picks;
  }

  async function syncPicks() {
    if (runtime.stopped) return;
    try {
      const detail = await FDAApi.fetchDraftDetail(
        runtime.league.seasonId,
        runtime.league.leagueId
      );

      // Whichever source knows about more picks is the one telling the truth:
      // mDraftDetail wins once the draft is over and carries real pick order,
      // rosters win while it is running.
      const fromRosters = picksFromRosters(runtime.state, detail.rosters);
      const picks = detail.picks.length >= fromRosters.length ? detail.picks : fromRosters;

      // lm-api-reads is a replica that does not materialise a draft until it is
      // finished: mid-draft it returns a placeholder slot for every pick and an
      // empty roster for every team. Applied as authoritative it erases every
      // pick the DOM observer found, on every poll, for the entire draft.
      runtime.apiBlind = detail.inProgress && !picks.length;
      let delta = { added: [], removed: [] };

      if (runtime.apiBlind) {
        if (!runtime.loggedApiBlind) {
          warn('ESPN reports the draft in progress but has no picks — reading the board instead.');
          runtime.loggedApiBlind = true;
        }
        runtime.state.lastSyncAt = Date.now();
      } else {
        if (!runtime.loggedPickShape && picks.length) {
          log('First parsed pick (verify shape):', picks[0]);
          runtime.loggedPickShape = true;
        }
        delta = FDADraftState.applyPicks(runtime.state, picks, 'api');
      }

      applyManualPicks();
      if (delta.added.length || delta.removed.length || runtime.backoffMs) {
        logState(delta);
      }
      runtime.backoffMs = 0;
      runtime.lastError = null;

      if (delta.added.length || delta.removed.length) {
        FDAPersist.saveDraft(runtime.league.leagueId, {
          picks: runtime.state.picks,
          myTeamId: runtime.state.myTeamId,
          settings: runtime.settings
        }).catch((e) => FDALog.debug('Draft snapshot failed:', e.message));
      }
    } catch (e) {
      runtime.lastError = e.message;
      runtime.backoffMs = runtime.backoffMs
        ? Math.min(runtime.backoffMs * 2, MAX_BACKOFF_MS)
        : MIN_POLL_MS;
      warn(`Pick sync failed (${e.message}); retrying in ${runtime.backoffMs}ms`);
    }

    render(activeFilter);

    const advertised = FDAApi.getPollingIntervalMs();
    const delay =
      runtime.backoffMs || Math.max(MIN_POLL_MS, advertised || 0);
    runtime.timer = setTimeout(syncPicks, delay);
  }

  async function boot() {
    const urlInfo = FDAConfig.parseUrl(location.href);
    if (!urlInfo) return;

    runtime.league = await resolveLeague();
    if (!runtime.league) {
      log('No league configured. Open the extension popup to add one.');
      return;
    }

    if (!urlInfo.isDraftRoom) {
      log(`Not a draft room (${urlInfo.path}); config saved, sync idle.`);
      return;
    }

    const league = runtime.league;
    try {
      const { settings } = await FDAApi.fetchSettings(league.seasonId, league.leagueId);
      runtime.settings = settings;
      reportSettingsMismatch(settings);

      const myTeamId = await detectMyTeamId(league);
      runtime.state = FDADraftState.createState({ settings, myTeamId });

      if (!runtime.state.myDraftSlot) {
        warn('Your team is not in the draft order yet; pick math will be limited.');
      } else {
        log(
          `Your draft slot: ${runtime.state.myDraftSlot} of ${runtime.state.teamCount}` +
            ` | your picks: ${runtime.state.myPicks.join(', ')}`
        );
      }

      // Projections do not move during a draft, so a cached pool is a complete
      // substitute — and re-fetching 500 players after a tab crash is the one
      // startup cost that can actually make you miss a pick.
      let players;
      let skipped = 0;
      try {
        const fetched = await FDAApi.fetchPlayerPool(league.seasonId, league.leagueId, {
          rankType: settings.playerRankType || 'PPR'
        });
        players = fetched.players;
        skipped = fetched.skipped;
        FDAPersist.savePool(league.seasonId, league.leagueId, players).catch((e) =>
          FDALog.debug('Pool snapshot failed:', e.message)
        );
      } catch (e) {
        const cached = await FDAPersist.loadPool(league.seasonId, league.leagueId);
        if (!cached) throw e;
        players = cached.players;
        runtime.notice = `Player pool is cached from ${new Date(cached.savedAt).toLocaleTimeString()} — projections may be stale.`;
        warn(`Pool fetch failed (${e.message}); using cached pool.`);
      }

      runtime.players = players;
      runtime.playersById = new Map(players.map((p) => [p.id, p]));
      runtime.playerIndex = FDADomObserver.buildIndex(players);
      log(
        `Player pool: ${players.length} loaded${skipped ? `, ${skipped} malformed skipped` : ''}` +
          ` | ${players.filter((p) => p.projectedPoints > 0).length} with projections` +
          ` | ${players.filter((p) => p.adp > 0).length} with ADP`
      );

      // ESPN's appliedTotal is league-scoped, but that is an empirical finding,
      // not a guarantee. Recompute a sample from raw stats to prove it per league.
      const check = FDAScoring.verifyScoring(players, settings.scoringItems);
      if (check.ok) {
        log(`Scoring verified: ${check.checked} players recomputed, ${Math.round(check.agreement * 100)}% agree`);
      } else {
        runtime.notice = `Projections may not match league scoring (${check.reason}). Treat VOR as approximate.`;
        warn(runtime.notice, check);
      }

      await mountPanel();
      startDomObserver();
      await syncPicks();
    } catch (e) {
      warn('Startup failed:', e.message, '— open the popup to check league settings.');
      runtime.notice = `Startup failed: ${e.message}. Check league settings in the popup.`;
      await mountPanel();
      render(null);
    }
  }

  // Popup asks the content script to verify a league because ESPN's CORS policy
  // only allows the fantasy.espn.com origin, not chrome-extension://.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'FDA_VERIFY_LEAGUE') {
      (async () => {
        try {
          const seasonId = msg.seasonId || FDAConfig.DEFAULT_SEASON;
          const { settings } = await FDAApi.fetchSettings(seasonId, msg.leagueId);
          const { teams } = await FDAApi.fetchTeams(seasonId, msg.leagueId);
          const swid = swidFromCookie();
          const mine = swid ? teams.find((t) => t.owners.includes(swid)) : null;
          sendResponse({
            ok: true,
            leagueName: settings.leagueName,
            teamCount: settings.teamCount,
            scoring: FDAApi.scoringLabel(settings),
            draftType: settings.draft.type,
            rounds: FDADraftState.rosterSize(settings.slotCounts),
            teams: teams.map((t) => ({ id: t.id, name: t.name })),
            detectedTeamId: mine ? mine.id : null
          });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
      })();
      return true;
    }

    if (msg.type === 'FDA_STATUS') {
      const s = runtime.state;
      sendResponse({
        ok: true,
        leagueId: runtime.league?.leagueId || null,
        inDraftRoom: !!(FDAConfig.parseUrl(location.href)?.isDraftRoom),
        poolSize: runtime.playersById.size,
        picks: s ? s.picks.length : 0,
        myTeamId: s ? s.myTeamId : null,
        lastSyncAt: s ? s.lastSyncAt : null,
        lastError: runtime.lastError
      });
      return true;
    }

    if (msg.type === 'FDA_RELOAD_CONFIG') {
      // Re-resolve in place; reloading the page could cost the draft seat.
      if (runtime.timer) clearTimeout(runtime.timer);
      FDADomObserver.stop();
      runtime.domEnabled = false;
      runtime.stopped = false;
      runtime.backoffMs = 0;
      boot();
      sendResponse({ ok: true });
      return true;
    }

    // Post-mortem hook: the ring buffer holds the last 500 events even when
    // nobody had the console open while the draft was going wrong.
    if (msg.type === 'FDA_LOGS') {
      sendResponse({ ok: true, text: FDALog.toText(FDALog.dump({ level: msg.level || 'debug' })) });
      return true;
    }
  });

  boot();
})();
