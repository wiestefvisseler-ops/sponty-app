'use strict';

/* ------------------------------------------------------------------ *
 *  engine.js — the matching brain.
 *
 *  Pure, dependency-free, and unit-tested. Given the set of currently
 *  active "I'm down to chill" signals in one group, it decides whether
 *  a threshold is crossed and who should be revealed to whom.
 *
 *  The rules (this is the whole product in ~10 lines):
 *    • 3 or more people down  -> GROUP hang. Everyone who's down is revealed
 *                                to each other; the rest of the group gets a
 *                                "join if you want" heads-up.
 *    • exactly 2 down AND both -> PAIR. Just those two are revealed to each
 *      ticked "1-on-1's fine"     other; the rest still get a heads-up.
 *    • anything else          -> nothing fires. Signals stay invisible.
 *      Nobody ever learns who quietly raised their hand.
 * ------------------------------------------------------------------ */

const GROUP_THRESHOLD = 3;

/**
 * @param {Array<{userId: string, oneOnOneOk: boolean}>} activeSignals
 * @returns {{triggered: boolean, mode: 'idle'|'group'|'pair', participantUserIds: string[]}}
 */
function resolveSignals(activeSignals) {
  const down = Array.isArray(activeSignals) ? activeSignals : [];

  if (down.length >= GROUP_THRESHOLD) {
    return { triggered: true, mode: 'group', participantUserIds: down.map((s) => s.userId) };
  }

  if (down.length === 2 && down[0].oneOnOneOk && down[1].oneOnOneOk) {
    return { triggered: true, mode: 'pair', participantUserIds: down.map((s) => s.userId) };
  }

  return { triggered: false, mode: 'idle', participantUserIds: [] };
}

module.exports = { resolveSignals, GROUP_THRESHOLD };
