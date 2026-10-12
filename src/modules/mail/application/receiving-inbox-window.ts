import type { ProviderConnection } from "../../accounts/domain/mail-provider";
import {
  fetchInboxMetadataWindow,
  MetadataWindowError,
  type MetadataWindowOptions,
} from "../../accounts/infrastructure/imap-metadata-window";
import {
  recoverReceiving,
  type ReceivingOwner,
  type ReceivingState,
} from "../../../shared/infrastructure/database/receiving-authority";
import { ReceivingExecutor } from "../../../shared/infrastructure/database/receiving-executor";
import { ReceivingPersistence } from "./receiving-persistence";

/** Disabled, explicitly invoked Stage 2 capability. No account enrollment here.
 * Null state is only for an already enrolled, empty disposable/new mailbox;
 * initialize's database authority rejects resetting an existing receiving row.
 * Uncertain commits propagate Stage 1's unresolved error: recover under locks
 * before another invocation, never blindly replay an old frozen UID window.
 */
export async function receiveInboxWindow(
  input: Readonly<{
    connection: ProviderConnection;
    executor: ReceivingExecutor;
    owner: ReceivingOwner;
    mailbox: string;
    initialized: boolean;
    options: MetadataWindowOptions;
  }>,
  createClient?: Parameters<typeof fetchInboxMetadataWindow>[3],
) {
  const { executor, mailbox } = input;
  const connection = structuredClone(input.connection);
  const owner = { ...input.owner };
  const options = { ...input.options };
  const guard = () => {
    if (options.signal?.aborted || performance.now() >= options.deadline)
      throw new MetadataWindowError("Obsolete metadata publication");
    options.assertCurrent();
  };
  const dbOptions = () => {
    guard();
    return {
      deadline: Math.min(options.deadline, performance.now() + 2000),
      signal: options.signal,
    };
  };
  let expected: ReceivingState | null = input.initialized
    ? await recoverReceiving(executor, owner, mailbox, dbOptions())
    : null;
  guard();
  const window = await fetchInboxMetadataWindow(
    connection,
    expected,
    options,
    createClient,
  );
  // Transport is fully retired before PostgreSQL admission.
  guard();
  const persistence = new ReceivingPersistence(executor);
  if (!expected) {
    await persistence.initialize(
      owner,
      mailbox,
      {
        complete: true,
        epoch: window.epoch,
        uidNext: window.uidNext,
      },
      dbOptions(),
    );
    expected = await recoverReceiving(executor, owner, mailbox, dbOptions());
  }
  guard();
  if (!window.evidence) return { state: expected, count: 0, exhausted: true };
  const state = await persistence.persist(
    owner,
    mailbox,
    expected,
    {
      kind: "history",
      evidence: window.evidence,
      metadata: window.metadata,
    },
    dbOptions(),
  );
  // Acknowledged COMMIT remains a fact even if cancellation arrives afterward.
  return {
    state,
    count: window.metadata.length,
    exhausted: state.historyBefore === 1n,
  };
}
