import type { ProviderConnection } from "../../accounts/domain/mail-provider";
import {
  fetchInboxMetadataWindow,
  MetadataWindowError,
  type MetadataWindowOptions,
} from "../../accounts/infrastructure/imap-metadata-window";
import {
  recoverReceivingEnrollment,
  recoverReceiving,
  type ReceivingOwner,
} from "../../../shared/infrastructure/database/receiving-authority";
import type { ReceivingExecutor } from "../../../shared/infrastructure/database/receiving-executor";
import { ReceivingPersistence } from "./receiving-persistence";

/** One bounded, recover-before-select turn. No saved in-memory checkpoint is
 * authoritative, including after lost initialization or publication replies. */
export async function receiveInboxTurn(
  input: Readonly<{
    connection: ProviderConnection;
    executor: ReceivingExecutor;
    owner: ReceivingOwner;
    account: string;
    mailbox: string;
    options: MetadataWindowOptions & { kind: "fresh" | "history" };
  }>,
  createClient?: Parameters<typeof fetchInboxMetadataWindow>[3],
) {
  const connection = structuredClone(input.connection);
  const owner = { ...input.owner };
  const { executor, account, mailbox } = input;
  const options = { ...input.options };
  const guard = () => {
    if (options.signal?.aborted || performance.now() >= options.deadline)
      throw new MetadataWindowError("Obsolete receiving turn");
    options.assertCurrent();
  };
  const dbOptions = () => {
    guard();
    return {
      deadline: Math.min(options.deadline, performance.now() + 2000),
      signal: options.signal,
    };
  };
  let expected = await recoverReceivingEnrollment(
    executor,
    owner,
    account,
    mailbox,
    dbOptions(),
  );
  guard();
  const window = await fetchInboxMetadataWindow(
    connection,
    expected,
    options,
    createClient,
  );
  guard();
  const persistence = new ReceivingPersistence(executor);
  if (!expected) {
    await persistence.initialize(
      owner,
      mailbox,
      { complete: true, epoch: window.epoch, uidNext: window.uidNext },
      dbOptions(),
    );
    expected = await recoverReceiving(executor, owner, mailbox, dbOptions());
  }
  guard();
  const state = window.evidence
    ? await persistence.persist(
        owner,
        mailbox,
        expected,
        {
          kind: options.kind,
          evidence: window.evidence,
          metadata: window.metadata,
        },
        dbOptions(),
      )
    : expected;
  return {
    state,
    count: window.metadata.length,
    moreFresh: state.freshThrough < window.uidNext - 1n,
  };
}
