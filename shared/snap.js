// Snapshots carry every item only now and then ("full"); in between, just the items that changed ("itemsDelta").
// mergeItems turns either kind back into the full list, in place, using a per-connection cache.
export function mergeItems(snap, cache) {
  if (!snap?.items) return snap;
  if (!snap.itemsDelta || !cache.items) {
    if (snap.itemsDelta) return snap; // a partial update before the first full one: wait for the refresh
    cache.items = new Map(snap.items.map(it => [it.id, it]));
  } else {
    for (const it of snap.items) cache.items.set(it.id, it);
    snap.items = [...cache.items.values()];
    delete snap.itemsDelta;
  }
  return snap;
}
