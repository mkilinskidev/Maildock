type EventClient = {
  close(): void;
  on?(event: "error", listener: (error: unknown) => void): unknown;
};

const failures = new WeakMap<object, () => void>();
const cleanup = new Set(["close", "logout", "mailboxClose"]);
const acknowledgedMutations = new Set([
  "append",
  "messageMove",
  "messageFlagsAdd",
  "messageFlagsRemove",
]);

/** The owner observes asynchronous failures; protocol promises still reject normally. */
export function guardImapClient<T extends EventClient>(client: T): T {
  let firstFailure: unknown;
  let failed = false;
  const check = () => {
    if (failed) throw firstFailure;
  };
  client.on?.("error", (error) => {
    if (failed) return;
    failed = true;
    firstFailure =
      error instanceof Error ? error : new Error("IMAP client failed.");
    try {
      client.close();
    } catch {
      // Preserve the first failure even if teardown itself fails.
    }
  });
  const guarded = new Proxy(client, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      const name = String(property);
      if (cleanup.has(name) || name === "on") return value.bind(target);
      return (...args: unknown[]) => {
        check();
        const result: unknown = Reflect.apply(value, target, args);
        if (
          result !== null &&
          typeof result === "object" &&
          Symbol.asyncIterator in result
        ) {
          return (async function* () {
            const iterator = (result as AsyncIterable<unknown>)[
              Symbol.asyncIterator
            ]();
            try {
              while (true) {
                check();
                const next = await iterator.next();
                check();
                if (next.done) return;
                yield next.value;
              }
            } finally {
              await iterator.return?.();
            }
          })();
        }
        if (result instanceof Promise) {
          return result.then((answer: unknown) => {
            // A positive remote acknowledgement must survive later teardown.
            if (!acknowledgedMutations.has(name)) check();
            return answer;
          });
        }
        check();
        return result;
      };
    },
  });
  failures.set(guarded, check);
  return guarded;
}

/** Also check after application work performed between protocol calls. */
export function assertImapHealthy(client: object): void {
  failures.get(client)?.();
}
