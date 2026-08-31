// Resilient element lookup. ESPN ships hashed, generated class names that change
// without notice, so nothing here depends on a single selector. Each target is a
// list of candidate strategies tried in order, from most stable (semantic and
// data attributes) to least (class names, then text matching).
//
// Every resolver returns null on failure. A miss is a degraded mode, not an
// error: the API is the source of truth and the DOM only ever front-runs it.
(function (root) {
  'use strict';

  const CACHE_MS = 5000;
  const cache = new Map();

  const classOf = (el) => {
    const c = el && el.className;
    if (typeof c === 'string') return c;
    if (c && typeof c.baseVal === 'string') return c.baseVal;
    return '';
  };

  const textOf = (el) => ((el && el.textContent) || '').replace(/\s+/g, ' ').trim();

  // ---- candidate primitives ----

  const bySelector = (selector) => ({
    name: `selector(${selector})`,
    find: (scope) => scope.querySelector(selector)
  });

  const bySelectorAll = (selector) => ({
    name: `selectorAll(${selector})`,
    findAll: (scope) => [...scope.querySelectorAll(selector)]
  });

  // Class names are generated, but the human-readable fragment inside them tends
  // to survive redesigns even when the hash suffix does not.
  const byClassContains = (fragment, tag = '*') => ({
    name: `classContains(${fragment})`,
    find: (scope) => byClassContains(fragment, tag).findAll(scope)[0] || null,
    findAll: (scope) =>
      [...scope.querySelectorAll(tag)].filter((el) =>
        classOf(el).toLowerCase().includes(fragment.toLowerCase())
      )
  });

  // Last resort: find the element whose own text matches, not an ancestor's.
  const byTextMatch = (pattern, tag = 'div,span,h1,h2,h3,p,li') => ({
    name: `textMatch(${pattern})`,
    find: (scope) => byTextMatch(pattern, tag).findAll(scope)[0] || null,
    findAll: (scope) =>
      [...scope.querySelectorAll(tag)].filter(
        (el) => el.children.length <= 1 && pattern.test(textOf(el))
      )
  });

  // ---- targets ----
  //
  // Filled in against a live draft room via tools/dom-probe.js. Order matters:
  // the first candidate that returns something wins and is reported in health().
  //
  // The jsx-NNNNNNNNN classes ESPN emits are styled-jsx build hashes and change
  // on every deploy, so nothing below references them. The human-readable
  // fragments beside them (pick-message__container, completedPick, on-the-clock)
  // have survived several redesigns.
  const TARGETS = {
    // The running list of completed picks.
    pickFeed: [
      bySelector('ul.pick-messages'),
      {
        name: 'parentOf(pick-message__container)',
        find: (scope) => {
          const first = byClassContains('pick-message__container').find(scope);
          return first ? first.parentElement : null;
        }
      },
      bySelector('.draft-board-grid')
    ],
    // One entry inside pickFeed.
    pickEntry: [
      bySelectorAll('.pick-message__container'),
      byClassContains('pick-message__container'),
      // Board cells carry the same information in a different shape.
      byClassContains('draft-board-grid-pick-cell')
    ],
    // Whatever announces who is currently selecting.
    onTheClock: [
      bySelector('[data-testid="current-pick"]'),
      byClassContains('current-pick-module-container'),
      byClassContains('on-the-clock'),
      byTextMatch(/on the clock/i)
    ],
    // The available-player table, used to notice players disappearing from it.
    playerTable: [
      bySelector('.players-table'),
      byClassContains('players-table'),
      {
        name: 'parentOf(playerinfo__playername)',
        find: (scope) => {
          const first = byClassContains('playerinfo__playername').find(scope);
          return first ? first.closest('table, [role="grid"], div') : null;
        }
      }
    ],
    // One row in playerTable — a player still available.
    playerRow: [
      bySelectorAll('.player-column__athlete'),
      byClassContains('playerinfo__playername')
    ],
    // "RND 13 of 17 00:30" — round context plus the pick timer.
    clock: [
      bySelector('[data-testid="clock"]'),
      byClassContains('clock__container'),
      byTextMatch(/RND\s*\d+\s*of\s*\d+/i)
    ]
  };

  function candidatesFor(target) {
    return TARGETS[target] || [];
  }

  function runCandidates(target, scope, all) {
    for (const candidate of candidatesFor(target)) {
      let result = null;
      try {
        result = all
          ? candidate.findAll
            ? candidate.findAll(scope)
            : [candidate.find(scope)].filter(Boolean)
          : candidate.find
            ? candidate.find(scope)
            : (candidate.findAll(scope)[0] ?? null);
      } catch {
        continue;
      }
      const hit = all ? result && result.length : result;
      if (hit) return { via: candidate.name, result };
    }
    return { via: null, result: all ? [] : null };
  }

  // Resolution is cached briefly: the observer asks on every mutation burst and
  // a full-document scan per burst is the kind of thing that drops frames.
  function resolve(target, { scope = document, fresh = false } = {}) {
    const key = `${target}:one`;
    const hit = cache.get(key);
    if (!fresh && hit && Date.now() - hit.at < CACHE_MS) {
      if (hit.result && hit.result.isConnected) return hit.result;
    }
    const { via, result } = runCandidates(target, scope, false);
    cache.set(key, { at: Date.now(), result, via });
    return result;
  }

  function resolveAll(target, { scope = document } = {}) {
    const { via, result } = runCandidates(target, scope, true);
    cache.set(`${target}:all`, { at: Date.now(), result, via });
    return result;
  }

  // Which strategy is currently carrying each target, for the health footer and
  // for noticing that ESPN changed its markup before it matters.
  function health() {
    const out = {};
    for (const target of Object.keys(TARGETS)) {
      const one = cache.get(`${target}:one`);
      const all = cache.get(`${target}:all`);
      const entry = one || all;
      out[target] = {
        configured: candidatesFor(target).length,
        via: entry ? entry.via : null,
        found: entry ? !!(Array.isArray(entry.result) ? entry.result.length : entry.result) : false
      };
    }
    return out;
  }

  const clearCache = () => cache.clear();

  root.FDASelectors = {
    TARGETS,
    bySelector,
    bySelectorAll,
    byClassContains,
    byTextMatch,
    classOf,
    textOf,
    resolve,
    resolveAll,
    health,
    clearCache
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
