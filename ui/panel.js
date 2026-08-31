// The overlay. Renders a view model and emits intent callbacks — it never reads
// engine state directly and never touches anything outside its own subtree.
(function (root) {
  'use strict';

  const { FDANflTeams } = root;
  const PANEL_ID = 'fda-panel';
  const POSITION_ORDER = ['QB', 'RB', 'WR', 'TE', 'DST', 'K'];
  const MILD_INJURY = ['QUESTIONABLE', 'PROBABLE'];

  // Slot ids that represent a starting spot worth showing in the roster grid.
  const SLOT_LABEL = {
    0: 'QB', 2: 'RB', 4: 'WR', 6: 'TE', 16: 'D/ST', 17: 'K',
    3: 'RB/WR', 5: 'WR/TE', 23: 'FLEX'
  };

  const state = {
    el: null,
    handlers: {},
    filter: null,
    expandedId: null,
    lastModel: null,
    drag: null,
    // playerId -> array of injury items, or null once a fetch came back empty.
    narratives: new Map()
  };

  function h(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  // ---- drag ----

  function beginDrag(event) {
    if (event.target.closest('.fda-iconbtn')) return;
    const rect = state.el.getBoundingClientRect();
    state.drag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
    event.preventDefault();
  }

  function onDragMove(event) {
    if (!state.drag) return;
    const maxLeft = window.innerWidth - state.el.offsetWidth;
    const maxTop = window.innerHeight - 40;
    const left = Math.min(Math.max(0, event.clientX - state.drag.dx), Math.max(0, maxLeft));
    const top = Math.min(Math.max(0, event.clientY - state.drag.dy), Math.max(0, maxTop));
    state.el.style.left = `${left}px`;
    state.el.style.top = `${top}px`;
    state.el.style.right = 'auto';
  }

  function endDrag() {
    if (!state.drag) return;
    state.drag = null;
    if (state.handlers.onMove) {
      state.handlers.onMove({ left: state.el.style.left, top: state.el.style.top });
    }
  }

  // ---- header / shell ----

  function buildShell() {
    const el = h('div');
    el.id = PANEL_ID;

    const header = h('div', 'fda-header');
    header.appendChild(h('span', 'fda-title', 'Draft Assistant'));

    const refresh = h('button', 'fda-iconbtn', '\u21bb');
    refresh.title = 'Refresh now';
    refresh.addEventListener('click', () => state.handlers.onRefresh && state.handlers.onRefresh());

    const collapse = h('button', 'fda-iconbtn', '\u2212');
    collapse.title = 'Collapse';
    collapse.addEventListener('click', () => {
      const collapsed = el.classList.toggle('fda-collapsed');
      collapse.textContent = collapsed ? '+' : '\u2212';
      if (state.handlers.onCollapse) state.handlers.onCollapse(collapsed);
    });

    header.appendChild(refresh);
    header.appendChild(collapse);
    header.addEventListener('mousedown', beginDrag);

    el.appendChild(header);
    el.appendChild(h('div', 'fda-body'));
    el.appendChild(h('div', 'fda-footer'));
    return el;
  }

  // ---- pieces ----

  function turnBar(meta, totalRounds) {
    const away = meta.picksUntilMyTurn;
    const bar = h('div', 'fda-turn');
    let main;

    if (meta.nextPick === null) {
      main = 'Draft complete';
    } else if (away === 0) {
      main = "You're on the clock";
      bar.classList.add('is-now');
    } else {
      main = `${away} pick${away === 1 ? '' : 's'} until your turn`;
      if (away <= 3) bar.classList.add('is-soon');
    }

    bar.appendChild(h('span', 'fda-turn-main', main));
    bar.appendChild(
      h(
        'span',
        'fda-turn-sub',
        `R${meta.currentRound}/${totalRounds} · pick ${meta.currentPick}` +
          (meta.nextPick !== null && away > 0 ? ` · yours ${meta.nextPick}` : '')
      )
    );
    return bar;
  }

  function section(title, extra) {
    const wrap = h('div', 'fda-section');
    const heading = h('div', 'fda-section-title', title);
    if (extra) heading.appendChild(extra);
    wrap.appendChild(heading);
    return wrap;
  }

  function badge(text, className) {
    return h('span', `fda-badge ${className}`, text);
  }

  function pickRow(entry, index, isOffPlan) {
    const p = entry.player;
    const btn = h('button', 'fda-pick');
    if (index === 0 && !isOffPlan) btn.classList.add('is-top');

    const row = h('div', 'fda-pick-row');
    row.appendChild(h('span', 'fda-rank', isOffPlan ? '~' : `${index + 1}`));
    row.appendChild(badge(p.position, `pos-${p.position}`));
    row.appendChild(h('span', 'fda-name', p.name));

    if (entry.injuryStatus && entry.injuryStatus !== 'ACTIVE') {
      const short = entry.injuryStatus.replace('INJURY_RESERVE', 'IR').slice(0, 4);
      const cls = MILD_INJURY.includes(entry.injuryStatus) ? 'fda-injury is-mild' : 'fda-injury';
      row.appendChild(badge(short, cls));
    }
    if (entry.lastInTier) row.appendChild(badge('cliff', 'fda-tag'));

    row.appendChild(
      h('span', 'fda-meta', `${entry.projectedPoints} · T${entry.tier}`)
    );
    btn.appendChild(row);
    btn.appendChild(h('div', 'fda-reason', entry.reason || entry.blockedReason || ''));

    if (state.expandedId === p.id) {
      btn.appendChild(detailList(entry));
    }

    btn.addEventListener('click', () => {
      state.expandedId = state.expandedId === p.id ? null : p.id;
      if (state.expandedId && state.handlers.onExpand) state.handlers.onExpand(p.id);
      if (state.lastModel) update(state.lastModel);
    });

    return btn;
  }

  function detailList(entry) {
    const p = entry.player;
    const dl = h('dl', 'fda-detail');
    const add = (label, value) => {
      dl.appendChild(h('dt', null, label));
      dl.appendChild(h('dd', null, String(value)));
    };

    add('Team', `${FDANflTeams.abbrev(p.proTeamId)} · ${p.position}${entry.positionRank}`);
    add('Projected', `${entry.projectedPoints} pts`);
    add('VOR', entry.vor);
    add('ADP', p.adp > 0 ? `${p.adp}${entry.adpDelta !== null ? ` (${entry.adpDelta > 0 ? '+' : ''}${entry.adpDelta})` : ''}` : 'none');
    add('Survives', `${Math.round(entry.survivalProbability * 100)}% to your next pick`);
    add('Wait costs', `${Math.round(entry.opportunityCost * 10) / 10} pts at ${p.position}`);
    if (entry.needMultiplier !== undefined) add('Need', `x${entry.needMultiplier} — ${entry.needLabel}`);
    if (entry.override) add('Override', entry.override);
    if (entry.blockedReason) add('Blocked', entry.blockedReason);

    // Narrative arrives after the row is already on screen; the status badge
    // stands on its own if it never does.
    if (entry.injuryStatus && entry.injuryStatus !== 'ACTIVE') {
      const narrative = state.narratives.get(p.id);
      if (narrative === undefined) add('Injury', 'loading…');
      else if (narrative && narrative.length) {
        const top = narrative[0];
        const headline = [top.type, top.detail, top.side].filter(Boolean).join(' ');
        add('Injury', headline || top.status || entry.injuryStatus);
        if (top.text) dl.appendChild(h('dd', 'fda-narrative', top.text));
        if (top.returnDate) add('Est. return', top.returnDate);
      } else {
        add('Injury', 'no detail available');
      }
    }

    const mark = h('button', 'fda-chip', 'Mark drafted');
    mark.title = 'Record a pick the API has not reported yet';
    mark.addEventListener('click', (e) => {
      e.stopPropagation();
      if (state.handlers.onMarkDrafted) state.handlers.onMarkDrafted(p.id);
    });
    dl.appendChild(h('dt', null, 'Manual'));
    const dd = h('dd');
    dd.appendChild(mark);
    dl.appendChild(dd);

    return dl;
  }

  function filterChips() {
    const wrap = h('div', 'fda-filters');
    const make = (label, value) => {
      const chip = h('button', 'fda-chip', label);
      if (state.filter === value) chip.classList.add('is-active');
      chip.addEventListener('click', () => {
        state.filter = state.filter === value ? null : value;
        if (state.handlers.onFilter) state.handlers.onFilter(state.filter);
      });
      return chip;
    };
    wrap.appendChild(make('All', null));
    for (const pos of POSITION_ORDER) wrap.appendChild(make(pos, pos));
    return wrap;
  }

  function rosterGrid(rosterState, slotCounts) {
    const wrap = h('div');
    const grid = h('div', 'fda-roster');

    for (const [slotId, label] of Object.entries(SLOT_LABEL)) {
      const total = slotCounts[slotId] || 0;
      if (!total) continue;
      const unfilled = rosterState.unfilled[slotId] || 0;
      const cell = h('div', 'fda-slot');
      if (unfilled > 0) cell.classList.add('is-unfilled');
      cell.appendChild(h('div', 'fda-slot-label', label));
      cell.appendChild(h('div', 'fda-slot-value', `${total - unfilled}/${total}`));
      grid.appendChild(cell);
    }
    wrap.appendChild(grid);

    const target = rosterState.benchTarget;
    const bench = h('div', 'fda-bench');
    bench.appendChild(h('span', null, `RB/WR bench ${rosterState.benchRbWr}/${target}`));
    const bar = h('div', 'fda-bar');
    const fill = h('div', 'fda-bar-fill');
    fill.style.width = `${Math.min(100, (rosterState.benchRbWr / target) * 100)}%`;
    bar.appendChild(fill);
    bench.appendChild(bar);
    bench.appendChild(h('span', null, `${rosterState.picksRemaining} picks left`));
    wrap.appendChild(bench);

    return wrap;
  }

  function renderFooter(health) {
    const footer = state.el.querySelector('.fda-footer');
    clear(footer);

    const light = (label, status, title) => {
      const span = h('span');
      span.title = title || '';
      const dot = h('span', `fda-dot is-${status}`);
      span.appendChild(dot);
      span.appendChild(document.createTextNode(label));
      return span;
    };

    footer.appendChild(light(`API ${health.api}`, health.apiStatus, health.apiDetail));
    footer.appendChild(light(`DOM ${health.dom}`, health.domStatus, health.domDetail));
    footer.appendChild(h('span', 'fda-footer-spacer'));
    footer.appendChild(h('span', null, health.lastSync || 'never synced'));
  }

  // ---- public ----

  function mount(handlers = {}) {
    if (state.el) return state.el;
    state.handlers = handlers;
    state.el = buildShell();
    document.body.appendChild(state.el);
    window.addEventListener('mousemove', onDragMove);
    window.addEventListener('mouseup', endDrag);
    return state.el;
  }

  function unmount() {
    if (!state.el) return;
    window.removeEventListener('mousemove', onDragMove);
    window.removeEventListener('mouseup', endDrag);
    state.el.remove();
    state.el = null;
  }

  function setNarrative(playerId, items) {
    state.narratives.set(playerId, items);
    if (state.expandedId === playerId && state.lastModel) update(state.lastModel);
  }

  function setPosition(pos) {
    if (!state.el || !pos) return;
    state.el.style.left = pos.left;
    state.el.style.top = pos.top;
    state.el.style.right = 'auto';
  }

  // model: { recommendation, slotCounts, totalRounds, health, notice, warning }
  function update(model) {
    if (!state.el) return;
    state.lastModel = model;

    const body = state.el.querySelector('.fda-body');
    clear(body);

    // Sits above everything, including the turn bar, because it is a statement
    // that the turn bar itself may be wrong.
    if (model.warning) {
      const wrap = h('div', 'fda-section');
      wrap.appendChild(h('div', 'fda-alert is-high', model.warning));
      body.appendChild(wrap);
    }

    if (model.notice) {
      const note = h('div', 'fda-section');
      note.appendChild(h('div', 'fda-empty', model.notice));
      body.appendChild(note);
    }

    const rec = model.recommendation;
    if (rec) {
      body.appendChild(turnBar(rec.meta, model.totalRounds));

      const unfilledNames = Object.entries(rec.rosterState.unfilled)
        .filter(([, n]) => n > 0)
        .map(([slotId]) => SLOT_LABEL[slotId] || `slot ${slotId}`);

      if (rec.positionalAlerts.length || rec.rosterState.urgent) {
        const alerts = section('Alerts');
        if (rec.rosterState.urgent) {
          alerts.appendChild(
            h(
              'div',
              'fda-alert is-high',
              `Only ${rec.rosterState.picksRemaining} picks left and ` +
                `${unfilledNames.join(', ')} still empty — fill starters now.`
            )
          );
        }
        for (const alert of rec.positionalAlerts) {
          const el = h('div', `fda-alert${alert.severity === 'high' ? ' is-high' : ''}`, alert.message);
          alerts.appendChild(el);
        }
        body.appendChild(alerts);
      }

      const picks = section(state.filter ? `Best ${state.filter}` : 'Recommended');
      picks.appendChild(filterChips());
      if (rec.top5.length) {
        rec.top5.forEach((entry, i) => picks.appendChild(pickRow(entry, i, false)));
      } else {
        picks.appendChild(h('div', 'fda-empty', 'Nothing available under your constraints.'));
      }
      body.appendChild(picks);

      if (rec.offPlanValue && rec.offPlanValue.length) {
        const off = section('Off-plan value');
        for (const entry of rec.offPlanValue) off.appendChild(pickRow(entry, 0, true));
        body.appendChild(off);
      }

      const roster = section('Your roster');
      roster.appendChild(rosterGrid(rec.rosterState, model.slotCounts));
      body.appendChild(roster);
    }

    renderFooter(model.health);
  }

  root.FDAPanel = { mount, unmount, update, setPosition, setNarrative, PANEL_ID };
})(typeof globalThis !== 'undefined' ? globalThis : window);
