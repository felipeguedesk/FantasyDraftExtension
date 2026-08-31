// Watches the draft room DOM as a low-latency secondary to the API.
//
// The DOM front-runs mDraftDetail by a second or two, which matters when the
// pick before yours decides whether your top recommendation is still there. It
// is never the source of truth: everything it reports is provisional until the
// API confirms it, and the whole layer can fail without degrading the product.
//
// The central difficulty: ESPN's pick markup carries no player id. A pick reads
// "Puka Nacua / LAR WR" and nothing else, so every observed pick has to be
// matched back to the API pool by name, pro team, and position. Ambiguity is
// resolved conservatively — an unmatched pick is dropped, never guessed.
(function (root) {
  'use strict';

  const S = root.FDASelectors;
  const log = root.FDALog || { debug() {}, info() {}, warn() {}, error() {} };

  // Mutations arrive in bursts as React commits; one read per burst is enough.
  const DEBOUNCE_MS = 250;
  // If nothing parses for this long the layer reports itself as broken so the
  // health footer shows drift before it costs a pick.
  const STALE_MS = 90000;

  const SUFFIXES = /\b(jr|sr|ii|iii|iv|v)\b/g;

  // "A.J. Brown" and "AJ Brown" have to collide, as do "D.K." and "DK".
  function normalizeName(name) {
    return String(name || '')
      .toLowerCase()
      .replace(/[.'`’]/g, '')
      .replace(/[^a-z0-9\s/]/g, ' ')
      .replace(SUFFIXES, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\s/g, '');
  }

  // Pool names for defenses are "Ravens D/ST"; the board shows the city or the
  // nickname alone, so defenses key off the pro team instead of the name.
  const isDefense = (position) => position === 'DST' || position === 'D/ST';

  function buildIndex(players) {
    const byName = new Map();
    const byTeamDefense = new Map();

    for (const p of players || []) {
      if (isDefense(p.position)) {
        if (p.proTeamId != null) byTeamDefense.set(String(p.proTeamId), p);
        const abbrev = root.FDANflTeams ? root.FDANflTeams.abbrev(p.proTeamId) : null;
        if (abbrev) byTeamDefense.set(abbrev.toUpperCase(), p);
      }
      const key = normalizeName(p.name);
      if (!key) continue;
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key).push(p);
    }

    return { byName, byTeamDefense, size: (players || []).length };
  }

  // Returns a player or null. Null is a normal outcome, not an error: the API
  // is a few hundred milliseconds behind, not wrong.
  function matchPlayer(index, { name, proTeam, position }) {
    if (!index) return null;

    if (isDefense(position) && proTeam) {
      const hit = index.byTeamDefense.get(String(proTeam).toUpperCase());
      if (hit) return hit;
    }

    const candidates = index.byName.get(normalizeName(name));
    if (!candidates || !candidates.length) return null;
    if (candidates.length === 1) return candidates[0];

    // Duplicate names exist across positions and teams every year.
    const narrowed = candidates.filter((p) => {
      const abbrev = root.FDANflTeams ? root.FDANflTeams.abbrev(p.proTeamId) : null;
      const teamOk = !proTeam || !abbrev || abbrev.toUpperCase() === String(proTeam).toUpperCase();
      const posOk = !position || !p.position || p.position === position;
      return teamOk && posOk;
    });

    return narrowed.length === 1 ? narrowed[0] : null;
  }

  // ---- parsing ----

  const childText = (el, fragment) => {
    const hit = S.byClassContains(fragment).find(el);
    return hit ? S.textOf(hit) : '';
  };

  // "Puka Nacua / LAR WR"
  const PLAYER_LINE = /^(.+?)\s*[/|]\s*([A-Za-z/]{2,4})\s+([A-Za-z/]{1,4})\s*$/;
  // "R1, P1 - Hughes Ya Daddy"
  const PICK_INFO = /R(?:ound)?\s*(\d+)\s*,\s*P(?:ick)?\s*(\d+)\s*[-–]\s*(.*)$/i;

  function parsePickMessage(el) {
    const infoEl = S.byClassContains('pick-info').find(el);
    const infoText = infoEl ? S.textOf(infoEl) : '';
    const whole = S.textOf(el);
    // The container concatenates the player line and the pick line with no
    // separator, so the player line is whatever the pick line is not.
    const playerLine = infoText && whole.endsWith(infoText)
      ? whole.slice(0, whole.length - infoText.length).trim()
      : childText(el, 'pick__message-information') || whole;

    const player = PLAYER_LINE.exec(playerLine);
    const info = PICK_INFO.exec(infoText);
    if (!player) return null;

    return {
      name: player[1].trim(),
      proTeam: player[2].toUpperCase(),
      position: player[3].toUpperCase().replace('D/ST', 'DST'),
      round: info ? Number(info[1]) : null,
      roundPick: info ? Number(info[2]) : null,
      teamName: info ? info[3].trim() : null
    };
  }

  // Board cells hold the same pick in separate elements. Their concatenated
  // textContent is unusable ("1.1PukaNacuaLARWR(11)"), so read the parts.
  function parsePickCell(el) {
    const coord = childText(el, 'roundPick') || childText(el, 'pickCellTop');
    const m = /(\d+)\s*\.\s*(\d+)/.exec(coord);
    if (!m) return null;

    const first = childText(el, 'playerFirstName');
    const last = childText(el, 'playerLastName');
    const name = `${first} ${last}`.trim();
    if (!name) return null;

    const proTeam = childText(el, 'playerProTeam');
    const bottom = childText(el, 'pickCellBottom');
    const posMatch = /\b(QB|RB|WR|TE|K|D\/ST|DST)\b/.exec(
      childText(el, 'playerPosition') || bottom
    );

    return {
      name,
      proTeam: proTeam.toUpperCase(),
      position: posMatch ? posMatch[1].replace('D/ST', 'DST') : null,
      round: Number(m[1]),
      roundPick: Number(m[2]),
      teamName: null
    };
  }

  // The board grid renders every pick of the draft up front and flips cells from
  // upcoming to completed in place, so the element count never changes. Only the
  // completed ones are a usable change signal.
  function completedEntries() {
    return S.resolveAll('pickEntry').filter(
      (el) => !S.classOf(el).toLowerCase().includes('upcomingpick')
    );
  }

  // Reads whichever representation the page is currently showing. Both are
  // tried because the board and the feed are separate tabs in ESPN's UI.
  function readPicks(index, teamCount, entries) {
    const raw = [];

    for (const el of entries || completedEntries()) {
      const parsed = S.classOf(el).toLowerCase().includes('pick-cell')
        ? parsePickCell(el)
        : parsePickMessage(el);
      if (parsed) raw.push(parsed);
    }

    const picks = [];
    const unmatched = [];
    const seen = new Set();

    for (const entry of raw) {
      const player = matchPlayer(index, entry);
      if (!player) {
        unmatched.push(`${entry.name} ${entry.proTeam || ''} ${entry.position || ''}`.trim());
        continue;
      }
      if (seen.has(player.id)) continue;
      seen.add(player.id);

      const overall =
        entry.round && entry.roundPick && teamCount
          ? (entry.round - 1) * teamCount + entry.roundPick
          : null;

      picks.push({
        playerId: player.id,
        round: entry.round,
        roundPick: entry.roundPick,
        overall,
        teamName: entry.teamName,
        keeper: false,
        autoDraft: false
      });
    }

    picks.sort((a, b) => (a.overall || 0) - (b.overall || 0));
    return { picks, unmatched, scanned: raw.length };
  }

  // "On the Clock: Pick 148" / "RND 13 of 17 00:30"
  function readClock() {
    const out = { currentPick: null, round: null, totalRounds: null, secondsLeft: null };

    const clockEl = S.resolve('onTheClock');
    if (clockEl) {
      const t = S.textOf(clockEl);
      const pick = /pick\s*#?\s*(\d+)/i.exec(t);
      if (pick) out.currentPick = Number(pick[1]);
    }

    const timerEl = S.resolve('clock');
    if (timerEl) {
      const t = S.textOf(timerEl);
      const rnd = /RND\s*(\d+)\s*of\s*(\d+)/i.exec(t);
      if (rnd) {
        out.round = Number(rnd[1]);
        out.totalRounds = Number(rnd[2]);
      }
      const time = /(\d{1,2}):(\d{2})/.exec(t);
      if (time) out.secondsLeft = Number(time[1]) * 60 + Number(time[2]);
    }

    return out;
  }

  // ---- observation ----

  const runtime = {
    observer: null,
    timer: null,
    getIndex: null,
    getTeamCount: null,
    onPicks: null,
    lastCount: 0,
    lastEntryCount: -1,
    lastParseAt: null,
    lastError: null,
    unmatched: []
  };

  function scan() {
    if (!runtime.getIndex) return;
    try {
      // The pick clock ticks once a second and the roster panes re-render
      // constantly, so most bursts carry no new pick. Cheap check first.
      const entries = completedEntries();
      if (entries.length === runtime.lastEntryCount) return;
      runtime.lastEntryCount = entries.length;

      const index = runtime.getIndex();
      const teamCount = runtime.getTeamCount ? runtime.getTeamCount() : 0;
      const { picks, unmatched, scanned } = readPicks(index, teamCount, entries);

      runtime.unmatched = unmatched;
      runtime.lastError = null;
      if (scanned) runtime.lastParseAt = Date.now();

      if (unmatched.length) {
        log.debug(`DOM: ${unmatched.length} pick(s) not yet in the pool:`, unmatched.slice(0, 5).join(', '));
      }

      if (picks.length && picks.length !== runtime.lastCount) {
        runtime.lastCount = picks.length;
        if (runtime.onPicks) runtime.onPicks(picks);
      }
    } catch (e) {
      runtime.lastError = e.message;
      log.warn('DOM scan failed:', e.message);
    }
  }

  function schedule() {
    if (runtime.timer) return;
    runtime.timer = setTimeout(() => {
      runtime.timer = null;
      scan();
    }, DEBOUNCE_MS);
  }

  function start({ getIndex, getTeamCount, onPicks } = {}) {
    stop();
    runtime.getIndex = getIndex;
    runtime.getTeamCount = getTeamCount;
    runtime.onPicks = onPicks;
    runtime.lastCount = 0;
    runtime.lastEntryCount = -1;

    // The feed subtree is remounted wholesale on some renders, so the observer
    // sits on body rather than on a node that can be replaced underneath it.
    runtime.observer = new MutationObserver(schedule);
    runtime.observer.observe(document.body, { childList: true, subtree: true });
    scan();
    log.info('DOM observer started');
  }

  function stop() {
    if (runtime.observer) runtime.observer.disconnect();
    if (runtime.timer) clearTimeout(runtime.timer);
    runtime.observer = null;
    runtime.timer = null;
  }

  function health() {
    const targets = S.health();
    const anyFound = Object.values(targets).some((t) => t.found);
    const stale = !runtime.lastParseAt || Date.now() - runtime.lastParseAt > STALE_MS;

    let status = 'ok';
    let detail = `${runtime.lastCount} picks seen in the DOM`;
    if (!runtime.observer) {
      status = 'off';
      detail = 'not started';
    } else if (runtime.lastError) {
      status = 'bad';
      detail = runtime.lastError;
    } else if (!anyFound) {
      status = 'bad';
      detail = 'no draft elements matched — ESPN markup likely changed';
    } else if (stale) {
      status = 'warn';
      detail = 'no picks parsed recently; API is carrying the draft';
    } else if (runtime.unmatched.length) {
      status = 'warn';
      detail = `${runtime.unmatched.length} pick(s) unmatched to the player pool`;
    }

    return { status, detail, picks: runtime.lastCount, targets };
  }

  root.FDADomObserver = {
    DEBOUNCE_MS,
    normalizeName,
    buildIndex,
    matchPlayer,
    parsePickMessage,
    parsePickCell,
    completedEntries,
    readPicks,
    readClock,
    start,
    stop,
    health
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
