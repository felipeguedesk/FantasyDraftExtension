(function () {
  'use strict';

  const { FDAConfig } = globalThis;
  const $ = (id) => document.getElementById(id);

  let cfg = FDAConfig.emptyConfig();
  let detected = null;
  let espnTabId = null;

  function toast(msg, ms = 2200) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.add('hidden'), ms);
  }

  async function persist(next) {
    cfg = await FDAConfig.save(next);
    render();
    // Tell the content script to pick up the change without a page reload,
    // which on draft day could cost the seat.
    if (espnTabId !== null) {
      chrome.tabs.sendMessage(espnTabId, { type: 'FDA_RELOAD_CONFIG' }, () => void chrome.runtime.lastError);
    }
  }

  function verifyLeague(leagueId, seasonId) {
    return new Promise((resolve) => {
      if (espnTabId === null) {
        resolve({ ok: false, error: 'Open an espn.com fantasy tab to verify' });
        return;
      }
      chrome.tabs.sendMessage(
        espnTabId,
        { type: 'FDA_VERIFY_LEAGUE', leagueId, seasonId },
        (res) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: 'No content script in that tab — reload it' });
          } else {
            resolve(res || { ok: false, error: 'No response' });
          }
        }
      );
    });
  }

  function leagueNode(league) {
    const isActive = cfg.activeLeagueId === league.leagueId;
    const li = document.createElement('li');
    li.className = 'league' + (isActive ? ' active' : '');

    const head = document.createElement('div');
    head.className = 'league-head';

    const title = document.createElement('div');
    title.className = 'league-title';
    const name = document.createElement('div');
    name.className = 'league-name';
    name.textContent = league.label || league.verified?.leagueName || `League ${league.leagueId}`;
    const meta = document.createElement('div');
    meta.className = 'league-meta';
    const bits = [`ID ${league.leagueId}`, league.seasonId];
    if (Number.isInteger(league.myTeamId)) bits.push(`team ${league.myTeamId}`);
    if (league.verified) bits.push(`${league.verified.teamCount}tm ${league.verified.scoring}`);
    meta.textContent = bits.join(' · ');
    title.append(name, meta);
    head.append(title);

    if (isActive) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = 'active';
      head.append(badge);
    }

    const body = document.createElement('div');
    body.className = 'league-body';

    const teamRow = document.createElement('div');
    teamRow.className = 'row';
    const teamLabel = document.createElement('label');
    teamLabel.textContent = 'My team';
    const teamInput = document.createElement('input');
    teamInput.placeholder = 'auto-detect';
    teamInput.value = Number.isInteger(league.myTeamId) ? String(league.myTeamId) : '';
    teamInput.addEventListener('change', async () => {
      const raw = teamInput.value.trim();
      const val = raw === '' ? null : Number(raw);
      if (raw !== '' && !Number.isInteger(val)) {
        toast('Team ID must be a number');
        return;
      }
      await persist(FDAConfig.upsertLeague(cfg, { leagueId: league.leagueId, myTeamId: val }));
      toast('Saved');
    });
    teamRow.append(teamLabel, teamInput);

    const verifyOut = document.createElement('div');
    verifyOut.className = 'verify';
    if (league.verified) {
      verifyOut.classList.add('ok');
      verifyOut.textContent =
        `${league.verified.leagueName} · ${league.verified.teamCount} teams · ` +
        `${league.verified.scoring} · ${league.verified.draftType} · ${league.verified.rounds} rounds`;
    }

    const actions = document.createElement('div');
    actions.className = 'actions';

    if (!isActive) {
      const use = document.createElement('button');
      use.className = 'sm';
      use.textContent = 'Use';
      use.addEventListener('click', async () => {
        const next = FDAConfig.normalize(cfg);
        next.activeLeagueId = league.leagueId;
        await persist(next);
        toast('Active league set');
      });
      actions.append(use);
    }

    const verify = document.createElement('button');
    verify.className = 'sm';
    verify.textContent = 'Verify';
    verify.addEventListener('click', async () => {
      verify.disabled = true;
      verify.textContent = 'Checking…';
      const res = await verifyLeague(league.leagueId, league.seasonId);
      verify.disabled = false;
      verify.textContent = 'Verify';
      verifyOut.classList.remove('ok', 'err');
      if (res.ok) {
        verifyOut.classList.add('ok');
        verifyOut.textContent =
          `${res.leagueName} · ${res.teamCount} teams · ${res.scoring} · ${res.draftType} · ${res.rounds} rounds`;
        await persist(
          FDAConfig.upsertLeague(cfg, {
            leagueId: league.leagueId,
            myTeamId: Number.isInteger(league.myTeamId) ? league.myTeamId : res.detectedTeamId,
            verified: {
              leagueName: res.leagueName,
              teamCount: res.teamCount,
              scoring: res.scoring,
              draftType: res.draftType,
              rounds: res.rounds
            }
          })
        );
      } else {
        verifyOut.classList.add('err');
        verifyOut.textContent = res.error;
      }
    });
    actions.append(verify);

    const del = document.createElement('button');
    del.className = 'sm danger';
    del.textContent = 'Remove';
    del.addEventListener('click', async () => {
      await persist(FDAConfig.removeLeague(cfg, league.leagueId));
      toast('League removed');
    });
    actions.append(del);

    body.append(teamRow, verifyOut, actions);
    li.append(head, body);
    return li;
  }

  function render() {
    const list = $('league-list');
    list.textContent = '';
    const leagues = Object.values(cfg.leagues).sort(
      (a, b) => (b.lastSeenAt || b.addedAt || 0) - (a.lastSeenAt || a.addedAt || 0)
    );
    for (const l of leagues) list.append(leagueNode(l));
    $('empty-note').classList.toggle('hidden', leagues.length > 0);

    const showBanner = detected && !cfg.leagues[detected.leagueId];
    $('detected').classList.toggle('hidden', !showBanner);
    if (showBanner) $('detected-id').textContent = detected.leagueId;
  }

  $('add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const leagueId = $('league-id').value.trim();
    const seasonId = Number($('season-id').value.trim());
    const label = $('label').value.trim();
    if (!/^\d+$/.test(leagueId)) {
      toast('League ID must be numeric');
      return;
    }
    await persist(FDAConfig.upsertLeague(cfg, { leagueId, seasonId, label }));
    $('league-id').value = '';
    $('label').value = '';
    toast(`Added league ${leagueId}`);
  });

  $('detected-save').addEventListener('click', async () => {
    if (!detected) return;
    await persist(
      FDAConfig.upsertLeague(cfg, {
        leagueId: detected.leagueId,
        seasonId: detected.seasonId,
        myTeamId: detected.teamId ?? undefined,
        lastSeenAt: Date.now()
      })
    );
    toast(`Saved league ${detected.leagueId}`);
  });

  (async function init() {
    cfg = await FDAConfig.load();
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url) {
      const info = FDAConfig.parseUrl(tab.url);
      if (info) {
        espnTabId = tab.id;
        if (info.leagueId) detected = info;
      }
    }
    render();
  })();
})();
