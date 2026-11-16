// Duello solver worker (v106): owns the dictionary + solver index off
// the main thread, so a ~130ms solve never freezes the 100ms clock tick
// and the ~1s index build never blocks the UI at all.
// The main thread posts {type:'init', words:[...]} once, then
// {type:'solve', requestId, board, rack, isFirst, premiums, wantAll}.
// Structured clone does NOT preserve custom props on arrays, so premiums
// travel separately from the board and are re-attached here before the
// solve. Replies are {type:'ready'} and {type:'solved', requestId, moves}.
// If this worker cannot be constructed, the main thread falls back to
// running the same engine synchronously (engine.js is already loaded
// in the page).
importScripts('engine.js');

let engine = null;

self.onmessage = function (e) {
  const d = (e && e.data) || {};
  if (d.type === 'init') {
    try {
      engine = self.DuelloEngine.createEngine(new Set(d.words || []));
      self.postMessage({ type: 'ready' });
    } catch (err) {
      self.postMessage({ type: 'error', error: String((err && err.message) || err) });
    }
    return;
  }
  if (d.type === 'solve') {
    if (!engine) {
      self.postMessage({ type: 'solved', requestId: d.requestId, moves: [] });
      return;
    }
    const board = (d.board || []).map(function (row) { return row.slice(); });
    board.__premiums = d.premiums || {};
    let moves = [];
    try {
      moves = engine.findMoves(board, d.rack || [], !!d.isFirst, !!d.wantAll) || [];
    } catch (err) {
      moves = [];
    }
    self.postMessage({ type: 'solved', requestId: d.requestId, moves: moves });
    return;
  }
};
