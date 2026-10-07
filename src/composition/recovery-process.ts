import { z } from "zod";
import { parseConfig } from "../shared/infrastructure/config/config";
import { createWorkerDatabase } from "../shared/infrastructure/database/database-worker";
import {
  validateDatabaseAuthority,
  DatabaseAuthorityError,
} from "../shared/infrastructure/database/database-authority";
import {
  RecoveryError,
  verifyRecoverySchema,
  verifyRecoveryState,
  verifyMaintenance,
} from "../shared/infrastructure/database/restore-verification";
import { restoreSecurityState } from "../modules/auth/application/restore-security-state";
import { openPrivateOutput, readPrivateInput } from "./recovery-channel";

const args = z.object({
  operation: z.enum([
    "maintain",
    "verify",
    "audit",
    "resume-mfa",
    "complete-mfa",
  ]),
  owner: z.string().min(1),
  channel: z.string().min(1).optional(),
  proof: z.string().optional(),
});
const proofSchema = z
  .object({
    password: z.string().min(1).max(128),
    code: z
      .string()
      .regex(/^\d{6}$/)
      .optional(),
  })
  .strict();
const receiptSchema = z
  .object({ receiptId: z.uuid(), ownerUserId: z.string() })
  .passthrough();
let database: ReturnType<typeof createWorkerDatabase> | undefined;
let output: Awaited<ReturnType<typeof openPrivateOutput>> | undefined;
try {
  const [operation, confirmation, owner, channel, proof] =
    process.argv.slice(2);
  if (
    confirmation !== "--writers-stopped-recovery-set-verified" ||
    process.argv.length > 7
  )
    throw new RecoveryError("recovery_offline");
  const options = args.parse({ operation, owner, channel, proof });
  const config = parseConfig(process.env);
  database = createWorkerDatabase({ ...config, databasePoolSize: 1 });
  await validateDatabaseAuthority(database.client);
  await verifyRecoverySchema(database.db);
  // Inspect other sessions too; confirmation also covers restart automation,
  // disconnected producers and filesystem writers which SQL cannot identify.
  const [writers] =
    await database.client`select exists(select from pg_catalog.pg_stat_activity where datname=current_database() and usename=session_user and pid<>pg_backend_pid()) as present`;
  if (writers.present) throw new RecoveryError("recovery_offline");
  if (options.operation === "audit") {
    if (options.channel || options.proof)
      throw new RecoveryError("recovery_channel");
    const checked = await verifyRecoveryState(
      database.db,
      config,
      options.owner,
    );
    if (checked.status !== "verified")
      throw new RecoveryError("recovery_incomplete");
    process.stderr.write(
      "recovery_audited: Authority, schema, owner, keys and referenced blobs verified offline.\n",
    );
  } else if (options.operation === "verify") {
    if (!options.channel) throw new RecoveryError("recovery_channel");
    if (options.proof) throw new RecoveryError("recovery_channel");
    const receipt = receiptSchema.parse(
      await readPrivateInput(options.channel),
    );
    if (receipt.ownerUserId !== options.owner)
      throw new RecoveryError("recovery_owner");
    const status = await verifyMaintenance(
      database.db,
      config,
      options.owner,
      receipt.receiptId,
    );
    if (status !== "verified") {
      process.stderr.write(
        "recovery_pending_mfa: Offline MFA completion required; keep writers and ingress stopped.\n",
      );
      process.exitCode = 2;
    } else
      process.stderr.write(
        "recovery_verified: Offline recovery verification completed.\n",
      );
  } else {
    const proof = options.proof
      ? proofSchema.parse(await readPrivateInput(options.proof))
      : undefined;
    if ((options.operation === "maintain") === Boolean(proof))
      throw new RecoveryError("recovery_proof");
    // Reserve exclusive protected destination BEFORE DB mutation. A failed
    // delivery after COMMIT leaves an unusable receipt: rerun offline with a
    // NEW output name, invalidating previous codes. No secret is logged.
    if (!options.channel) throw new RecoveryError("recovery_channel");
    output = await openPrivateOutput(options.channel);
    const result = await restoreSecurityState(
      database.db,
      config,
      options.owner,
      options.operation,
      proof,
    );
    await output.writeFile(
      JSON.stringify({ ...result, ownerUserId: options.owner }) + "\n",
    );
    await output.sync();
    if (result.status === "pending_mfa") {
      process.stderr.write(
        "recovery_pending_mfa: Offline MFA completion required; keep writers and ingress stopped.\n",
      );
      process.exitCode = 2;
    } else
      process.stderr.write(
        "recovery_maintained: Security maintenance committed; protect the new local recovery receipt.\n",
      );
  }
} catch (error) {
  const category =
    error instanceof RecoveryError || error instanceof DatabaseAuthorityError
      ? error.category
      : "recovery_refused";
  process.stderr.write(
    `${category}: Offline recovery refused; keep writers and ingress stopped.\n`,
  );
  process.exitCode = 1;
} finally {
  await output?.close().catch(() => undefined);
  await database?.client.end().catch(() => undefined);
}
