import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  ownerPasswordSchema,
  passwordMinLength,
  passwordMaxLength,
} from "../../src/modules/auth/domain/password-policy";

const fixture = vi.hoisted(() => ({
  read: vi.fn(),
  recover: vi.fn(),
  end: vi.fn(),
  output: [] as string[],
}));
vi.mock("../../src/shared/infrastructure/config/config", () => ({
  parseConfig: () => ({}),
}));
vi.mock("../../src/shared/infrastructure/database/database-worker", () => ({
  createWorkerDatabase: () => ({
    client: { end: fixture.end },
    db: { transaction: (work: (tx: object) => unknown) => work({}) },
  }),
}));
vi.mock("../../src/shared/infrastructure/database/database-authority", () => ({
  validateDatabaseAuthority: vi.fn(),
}));
vi.mock(
  "../../src/shared/infrastructure/database/restore-verification",
  () => ({ verifyRecoverySchema: vi.fn() }),
);
vi.mock("../../src/modules/auth/application/owner-recovery-state", () => ({
  lockOwnerRecovery: vi.fn(),
}));
vi.mock("../../src/modules/auth/application/owner-recovery", () => ({
  inspectOwnerRecovery: () => ({
    status: "ready",
    owner: { id: "owner-id", username: "owner-01" },
  }),
  recoverOwner: fixture.recover,
  OwnerRecoveryRejected: class extends Error {
    constructor(readonly category: string) {
      super(category);
    }
  },
}));
vi.mock("../../src/composition/owner-recovery-terminal", () => ({
  readTerminal: fixture.read,
  TerminalInterrupted: class extends Error {},
}));

const originalArgs = process.argv;
const originalExit = process.exitCode;
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  fixture.end.mockResolvedValue(undefined);
  fixture.output = [];
  process.argv = ["node", "owner-recovery-process"];
  process.exitCode = undefined;
  vi.stubGlobal("process", {
    ...process,
    argv: process.argv,
    stdin: { isTTY: true },
    stdout: {
      isTTY: true,
      write: (text: string) => {
        fixture.output.push(text);
      },
    },
    stderr: {
      write: (text: string) => {
        fixture.output.push(text);
      },
    },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  process.argv = originalArgs;
  process.exitCode = originalExit;
});

it.each([
  ["valid", "p".repeat(passwordMinLength), true],
  ["too short", "p".repeat(passwordMinLength - 1), false],
  ["too long", "p".repeat(passwordMaxLength + 1), false],
])(
  "shows shared policy before hidden prompts and safely handles %s passwords",
  async (_name, password, valid) => {
    let prompt = 0;
    fixture.read.mockImplementation(async (label: string, secret?: boolean) => {
      if (prompt++ === 0) return "RECOVER OWNER";
      const output = fixture.output.join("");
      expect(output).toContain(
        `New password requirements:\n  - At least ${passwordMinLength} characters.\n  - At most ${passwordMaxLength} characters.\n\n`,
      );
      expect(label).toBe(
        prompt === 2 ? "New password: " : "Confirm password: ",
      );
      expect(secret).toBeUndefined(); // readTerminal defaults to hidden input.
      return password;
    });
    await import("../../src/composition/owner-recovery-process");
    expect(ownerPasswordSchema.safeParse(password).success).toBe(valid);
    expect(fixture.recover).toHaveBeenCalledTimes(valid ? 1 : 0);
    if (!valid)
      expect(fixture.output.join("")).toContain(
        "owner_recovery_password_policy: No changes submitted.",
      );
    expect(fixture.output.join("")).not.toContain(password);
    expect(fixture.end).toHaveBeenCalledTimes(1);
  },
);
