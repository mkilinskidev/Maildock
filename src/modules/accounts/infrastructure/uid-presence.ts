/** Independent protocol bounds; metadata fetch size must not control presence SEARCH. */
export function* presenceBatches(uids: readonly string[]): Generator<string[]> {
  let batch: string[] = [];
  let length = 0;
  for (const uid of uids) {
    if (!/^[1-9]\d*$/.test(uid) || BigInt(uid) > 0xffffffffn)
      throw new Error("Invalid snapshot UID.");
    if (batch.length === 1000 || length + uid.length + 1 > 8000) {
      yield batch;
      batch = [];
      length = 0;
    }
    batch.push(uid);
    length += uid.length + 1;
  }
  if (batch.length) yield batch;
}

export function missingUids(
  group: readonly string[],
  response: unknown,
): string[] {
  if (!Array.isArray(response)) throw new Error("UID reconciliation failed.");
  const requested = new Set(group.map(Number));
  const present = new Set<number>();
  for (const uid of response) {
    if (
      !Number.isInteger(uid) ||
      uid < 1 ||
      uid > 0xffffffff ||
      !requested.has(uid) ||
      present.has(uid)
    )
      throw new Error("Invalid UID reconciliation response.");
    present.add(uid);
  }
  return group.filter((uid) => !present.has(Number(uid)));
}
