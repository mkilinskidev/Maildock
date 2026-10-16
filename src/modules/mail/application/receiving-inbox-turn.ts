import type { ProviderConnection } from "../../accounts/domain/mail-provider";
import {
  fetchInboxMetadataWindow,
  MetadataWindowError,
  type MetadataWindowOptions,
} from "../../accounts/infrastructure/imap-metadata-window";
import {
  recoverInboxIdentity,
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
    bootstrap?: boolean;
    configurationVersion?: bigint;
    receivingLifecycleVersion?: bigint;
    pollMs?: number;
    options: MetadataWindowOptions & { kind: "fresh" | "history" };
  }>,
  createClient?: Parameters<typeof fetchInboxMetadataWindow>[3],
) {
  const connection = structuredClone(input.connection);
  const owner = { ...input.owner };
  const { executor, account } = input;
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
  const recovered = await recoverInboxIdentity(
    executor,
    owner,
    account,
    input.mailbox,
    input.bootstrap ?? false,
    input.configurationVersion,
    input.receivingLifecycleVersion,
    dbOptions(),
  );
  const { mailbox, identity } = recovered;
  let expected = recovered.state;
  const rebind =
    expected !== null && recovered.binding !== identity.configuration;
  guard();
  const window = await fetchInboxMetadataWindow(
    connection,
    expected,
    {
      ...options,
      allowIdentityTransition: true,
      selectOnly: rebind || recovered.missing,
      reconcileKnown:
        options.kind === "fresh" ? recovered.reconcileKnown : undefined,
    },
    createClient,
  );
  guard();
  const persistence = new ReceivingPersistence(executor);
  if (recovered.missing) {
    await persistence.bootstrap(
      owner,
      mailbox,
      identity,
      { complete: true, epoch: window.epoch, uidNext: window.uidNext },
      dbOptions(),
    );
    expected = await recoverReceiving(executor, owner, mailbox, dbOptions());
  }
  if (!expected) {
    await persistence.initialize(
      owner,
      mailbox,
      { complete: true, epoch: window.epoch, uidNext: window.uidNext },
      dbOptions(),
      identity,
    );
    expected = await recoverReceiving(executor, owner, mailbox, dbOptions());
  }
  if (rebind || expected.epoch !== window.epoch) {
    const state = await persistence.persist(
      owner,
      mailbox,
      expected,
      {
        kind: "epoch",
        complete: true,
        epoch: window.epoch,
        uidNext: window.uidNext,
        rebind,
      },
      dbOptions(),
      identity,
    );
    return { state, count: 0, moreFresh: true, identityTransition: true };
  }
  guard();
  const state =
    window.reconciliation?.known.length === 0 && expected.reconcileAfter === 0n
      ? await persistence.settleEmptyObservation(
          owner,
          mailbox,
          expected,
          identity,
          recovered.demandGeneration!,
          input.pollMs ?? 15_000,
          dbOptions(),
        )
      : window.reconciliation
        ? await persistence.persist(
            owner,
            mailbox,
            expected,
            {
              kind: "repair",
              complete: true,
              epoch: window.epoch,
              ...window.reconciliation,
            },
            dbOptions(),
            identity,
            {
              generation: recovered.demandGeneration!,
              pollMs: input.pollMs ?? 15_000,
            },
          )
        : window.evidence
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
              identity,
            )
          : expected;
  return {
    state,
    count: window.metadata.length,
    moreFresh: state.freshThrough < window.uidNext - 1n,
  };
}
