// Ring-buffer logger. Draft day is not the time to be scrolling a console with
// 40 minutes of history in it, and a post-mortem needs the last N events even
// when nothing was being watched at the time.
(function (root) {
  'use strict';

  const TAG = '[FDA]';
  const CAPACITY = 500;
  const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

  const buffer = [];
  let seq = 0;
  // debug is recorded but not mirrored to the console unless asked for.
  let consoleLevel = LEVELS.info;

  function record(level, args) {
    const entry = {
      seq: ++seq,
      at: Date.now(),
      level,
      message: args
        .map((a) => {
          if (typeof a === 'string') return a;
          try {
            return JSON.stringify(a);
          } catch {
            return String(a);
          }
        })
        .join(' ')
    };

    buffer.push(entry);
    if (buffer.length > CAPACITY) buffer.shift();

    if (LEVELS[level] >= consoleLevel) {
      const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
      console[method](TAG, ...args);
    }
    return entry;
  }

  function dump({ level = 'debug', since = 0 } = {}) {
    const floor = LEVELS[level] ?? LEVELS.debug;
    return buffer.filter((e) => LEVELS[e.level] >= floor && e.at >= since);
  }

  function toText(entries) {
    return (entries || buffer)
      .map((e) => `${new Date(e.at).toISOString()} ${e.level.toUpperCase()} ${e.message}`)
      .join('\n');
  }

  root.FDALog = {
    CAPACITY,
    debug: (...a) => record('debug', a),
    info: (...a) => record('info', a),
    warn: (...a) => record('warn', a),
    error: (...a) => record('error', a),
    dump,
    toText,
    size: () => buffer.length,
    setConsoleLevel: (name) => {
      if (LEVELS[name]) consoleLevel = LEVELS[name];
    },
    clear: () => {
      buffer.length = 0;
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
