'use strict';

const DEFAULT_THRESHOLD = 3;

/**
 * @param {Array<{userId: string, oneOnOneOk: boolean}>} activeSignals
 * @param {number} threshold - minimum people needed for a group hang
 * @returns {{triggered: boolean, mode: 'idle'|'group'|'pair', participantUserIds: string[]}}
 */
function resolveSignals(activeSignals, threshold = DEFAULT_THRESHOLD) {
  const down = Array.isArray(activeSignals) ? activeSignals : [];

  if (down.length >= threshold) {
    return { triggered: true, mode: 'group', participantUserIds: down.map((s) => s.userId) };
  }

  if (down.length === 2 && down[0].oneOnOneOk && down[1].oneOnOneOk) {
    return { triggered: true, mode: 'pair', participantUserIds: down.map((s) => s.userId) };
  }

  return { triggered: false, mode: 'idle', participantUserIds: [] };
}

module.exports = { resolveSignals, DEFAULT_THRESHOLD };
