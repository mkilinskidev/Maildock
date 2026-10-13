import assert from "node:assert/strict";

export type Inventory = {
  epoch: string;
  next: number;
  items: { uid: number; id: string }[];
};
export type Placement = {
  uid: number;
  epoch: string;
  account: string;
  id: string;
};
export type Frontier = {
  mailbox: string;
  epoch: string;
  f: number;
  e: number;
  revision: number;
  placements: Placement[];
  history: number;
};
export type Publication = {
  mailbox: string;
  epoch: string;
  revision: number;
  oldF: number;
  f: number;
  oldE: number;
  e: number;
  metadata: Placement[];
};
export type Snapshot = { at: string; states: Frontier[]; audit: Publication[] };
export type Identity = {
  user: string;
  account: string;
  mailbox: string;
  baselineNext: number;
};

export function historyCandidates(
  snapshot: Snapshot,
  accounts: Identity[],
  target: number,
) {
  assert(
    snapshot.states.every((s) => s.history <= target),
    "History target overshoot",
  );
  return accounts.filter(
    (a) =>
      (snapshot.states.find((s) => s.mailbox === a.mailbox)?.history ?? 0) <
      target,
  );
}

export function verifySnapshot(
  snapshot: Snapshot,
  accounts: Identity[],
  inventory: Map<string, Inventory>,
) {
  for (const a of accounts) {
    const known = inventory.get(a.user)!;
    const state = snapshot.states.find((s) => s.mailbox === a.mailbox);
    if (!state) {
      assert(
        !snapshot.audit.some((p) => p.mailbox === a.mailbox),
        "Publication without enrollment",
      );
      continue; // A failure during enrollment may leave only a subset initialized.
    }
    assert.equal(state.epoch, known.epoch);
    assert(
      state.e >= 1 &&
        state.e <= a.baselineNext &&
        state.f >= a.baselineNext - 1,
    );
    const exact = (placements: Placement[], low: number, high: number) => {
      const expected = known.items
        .filter((v) => v.uid >= low && v.uid <= high)
        .sort((a, b) => a.uid - b.uid);
      assert.deepEqual(
        placements.map((v) => v.uid).sort((a, b) => a - b),
        expected.map((v) => v.uid),
        "Exact covered UID set",
      );
      for (const p of placements) {
        assert.equal(p.account, a.account);
        assert.equal(p.epoch, known.epoch);
        assert.equal(p.id, expected.find((v) => v.uid === p.uid)!.id);
      }
    };
    exact(state.placements, state.e, state.f);
    let f = a.baselineNext - 1,
      e = a.baselineNext,
      revision = 0,
      history = 0;
    for (const p of snapshot.audit.filter((v) => v.mailbox === a.mailbox)) {
      assert.equal(p.epoch, known.epoch);
      assert.equal(p.revision, ++revision);
      assert.equal(p.oldF, f);
      assert.equal(p.oldE, e);
      assert(p.f >= f && p.e <= e && p.e >= 1);
      assert(
        p.f > f !== p.e < e,
        "Exactly one frontier advances per publication",
      );
      assert(p.f - f <= 128 && e - p.e <= 128, "128 numeric UID bound");
      exact(p.metadata, p.f > f ? f + 1 : p.e, p.f > f ? p.f : e - 1);
      if (p.e < e) history++;
      f = p.f;
      e = p.e;
    }
    assert.equal(state.f, f);
    assert.equal(state.e, e);
    assert.equal(state.revision, revision);
    assert.equal(state.history, history);
  }
}

/** No servers: positive/negative controls exercise the same boundary oracle. */
export function checkOracle() {
  const accounts = [{ user: "u", account: "a", mailbox: "m", baselineNext: 5 }];
  const known = new Map([
    [
      "u",
      {
        epoch: "7",
        next: 5,
        items: [
          { uid: 1, id: "one" },
          { uid: 3, id: "three" },
          { uid: 4, id: "four" },
        ],
      },
    ],
  ]);
  const metadata = [
    { uid: 3, epoch: "7", account: "a", id: "three" },
    { uid: 4, epoch: "7", account: "a", id: "four" },
  ];
  const valid: Snapshot = {
    at: "fixture",
    states: [
      {
        mailbox: "m",
        epoch: "7",
        f: 4,
        e: 3,
        revision: 1,
        history: 1,
        placements: metadata,
      },
    ],
    audit: [
      {
        mailbox: "m",
        epoch: "7",
        revision: 1,
        oldF: 4,
        f: 4,
        oldE: 5,
        e: 3,
        metadata,
      },
    ],
  };
  verifySnapshot(valid, accounts, known);
  assert.equal(historyCandidates(valid, accounts, 1).length, 0);
  assert.equal(historyCandidates(valid, accounts, 2).length, 1);
  assert.throws(() => historyCandidates(valid, accounts, 0));
  const mutations: ((s: Snapshot) => void)[] = [
    (s) => {
      s.states[0].placements.pop();
    },
    (s) => {
      s.states[0].placements.push({ ...s.states[0].placements[0] });
    },
    (s) => {
      s.states[0].placements[0].account = "wrong";
    },
    (s) => {
      s.states[0].placements[0].id = "wrong";
    },
    (s) => {
      s.states[0].epoch = "8";
    },
    (s) => {
      s.audit[0].metadata = [];
    },
    (s) => {
      s.audit[0].oldE = 6;
    },
    (s) => {
      s.states[0].revision = 2;
    },
    (s) => {
      s.audit[0].f = 5;
    },
    (s) => {
      s.audit[0].e = -124;
    },
  ];
  for (const mutate of mutations) {
    const s = structuredClone(valid);
    mutate(s);
    assert.throws(() => verifySnapshot(s, accounts, known));
  }
  console.log(
    `Oracle checks PASS: positive sparse interval and ${mutations.length} negative controls`,
  );
}
