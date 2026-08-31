// The DOM layer is the one part of the extension that cannot be tested against
// the real thing on demand — a live draft room exists for about an hour a year.
// These fixtures are transcribed from tools/dom-probe.js output taken in a real
// 2026 mock draft, so they encode the markup as it actually shipped.
const test = require('node:test');
const assert = require('node:assert');

// Minimal element shim: enough for classContains/textOf, nothing more.
class El {
  constructor(className = '', text = '', children = []) {
    this.className = className;
    this.ownText = text;
    this.children = children;
    for (const c of children) c.parentElement = this;
    this.isConnected = true;
  }
  get textContent() {
    return this.children.length
      ? this.children.map((c) => c.textContent).join('')
      : this.ownText;
  }
  descendants() {
    return this.children.flatMap((c) => [c, ...c.descendants()]);
  }
  querySelectorAll() {
    return this.descendants();
  }
  querySelector() {
    return this.descendants()[0] || null;
  }
  closest() {
    return this;
  }
}

require('../content/selectors.js');
require('../shared/nfl-teams.js');
require('../content/dom-observer.js');

const DOM = globalThis.FDADomObserver;

const player = (id, name, position, proTeamId) => ({ id, name, position, proTeamId });

const POOL = [
  player(4426515, 'Puka Nacua', 'WR', 14),
  player(3116406, 'Tyreek Hill', 'WR', 15),
  player(4362628, 'Michael Pittman Jr.', 'WR', 11),
  player(2976499, 'A.J. Brown', 'WR', 21),
  player(-16033, 'Ravens D/ST', 'DST', 33),
  // Same name, different players — the case that makes name-only matching unsafe.
  player(111, 'Josh Allen', 'QB', 2),
  player(222, 'Josh Allen', 'LB', 26)
];

const index = DOM.buildIndex(POOL);

test('name normalization collapses punctuation, spacing, and suffixes', () => {
  assert.equal(DOM.normalizeName('A.J. Brown'), DOM.normalizeName('AJ Brown'));
  assert.equal(DOM.normalizeName('Michael Pittman Jr.'), DOM.normalizeName('Michael Pittman'));
  assert.equal(DOM.normalizeName("De'Von Achane"), DOM.normalizeName('DeVon Achane'));
  assert.equal(DOM.normalizeName('  Puka   Nacua '), 'pukanacua');
});

test('a player is matched back to the pool by name alone when unambiguous', () => {
  const hit = DOM.matchPlayer(index, { name: 'Puka Nacua', proTeam: 'LAR', position: 'WR' });
  assert.equal(hit.id, 4426515);
});

test('duplicate names are disambiguated by position, not guessed', () => {
  const qb = DOM.matchPlayer(index, { name: 'Josh Allen', proTeam: 'BUF', position: 'QB' });
  assert.equal(qb.id, 111);

  // No position and no usable team: refuse rather than pick one at random.
  const ambiguous = DOM.matchPlayer(index, { name: 'Josh Allen' });
  assert.equal(ambiguous, null);
});

test('a player not in the pool yields null instead of throwing', () => {
  assert.equal(DOM.matchPlayer(index, { name: 'Nobody At All', position: 'RB' }), null);
});

test('defenses match on pro team because the board never shows the pool name', () => {
  const hit = DOM.matchPlayer(index, { name: 'Baltimore', proTeam: 'BAL', position: 'DST' });
  assert.equal(hit.id, -16033);
});

test('a pick message parses into name, team, position, and coordinates', () => {
  const el = new El('pick-message__container', '', [
    new El('pick__message-information', 'Puka Nacua / LAR WR'),
    new El('pick-info', 'R1, P1 - Hughes Ya Daddy')
  ]);

  assert.deepEqual(DOM.parsePickMessage(el), {
    name: 'Puka Nacua',
    proTeam: 'LAR',
    position: 'WR',
    round: 1,
    roundPick: 1,
    teamName: 'Hughes Ya Daddy'
  });
});

test('a board cell parses despite its textContent being unseparated', () => {
  const el = new El('draft-board-grid-pick-cell completedPick', '', [
    new El('pickCellTop', '', [new El('roundPick', '1.1')]),
    new El('pickCellMiddle', '', [
      new El('playerFirstName', 'Puka'),
      new El('playerLastName', 'Nacua')
    ]),
    new El('pickCellBottom', '', [
      new El('playerProTeam', 'LAR'),
      new El('playerPosition', 'WR')
    ])
  ]);

  // The concatenated text is the exact garbage the probe reported.
  assert.equal(el.textContent, '1.1PukaNacuaLARWR');

  const parsed = DOM.parsePickCell(el);
  assert.equal(parsed.name, 'Puka Nacua');
  assert.equal(parsed.proTeam, 'LAR');
  assert.equal(parsed.position, 'WR');
  assert.equal(parsed.round, 1);
  assert.equal(parsed.roundPick, 1);
});

test('an empty upcoming cell parses to null rather than a phantom pick', () => {
  const el = new El('draft-board-grid-pick-cell upcomingPick', '', [
    new El('pickCellTop', '', [new El('roundPick', '13.5')])
  ]);
  assert.equal(DOM.parsePickCell(el), null);
});

test('overall pick number is derived from round and pick within round', () => {
  const messages = [
    new El('pick-message__container', '', [
      new El('pick__message-information', 'Puka Nacua / LAR WR'),
      new El('pick-info', 'R1, P1 - Hughes Ya Daddy')
    ]),
    new El('pick-message__container', '', [
      new El('pick__message-information', 'Tyreek Hill / MIA WR'),
      new El('pick-info', 'R2, P3 - Amazon Shoppers')
    ])
  ];

  const originalResolveAll = globalThis.FDASelectors.resolveAll;
  globalThis.FDASelectors.resolveAll = () => messages;
  try {
    const { picks, unmatched } = DOM.readPicks(index, 12);
    assert.equal(unmatched.length, 0);
    assert.deepEqual(
      picks.map((p) => [p.playerId, p.overall]),
      [
        [4426515, 1],
        // Round 2, pick 3 in a 12-team league is overall 15.
        [3116406, 15]
      ]
    );
  } finally {
    globalThis.FDASelectors.resolveAll = originalResolveAll;
  }
});

test('a pick for a player outside the pool is reported, not silently dropped', () => {
  const messages = [
    new El('pick-message__container', '', [
      new El('pick__message-information', 'Some Rookie / SEA RB'),
      new El('pick-info', 'R5, P2 - Blitzburgh')
    ])
  ];

  const originalResolveAll = globalThis.FDASelectors.resolveAll;
  globalThis.FDASelectors.resolveAll = () => messages;
  try {
    const { picks, unmatched } = DOM.readPicks(index, 12);
    assert.equal(picks.length, 0);
    assert.deepEqual(unmatched, ['Some Rookie SEA RB']);
  } finally {
    globalThis.FDASelectors.resolveAll = originalResolveAll;
  }
});
