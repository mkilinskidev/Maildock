import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

type Service = {
  ports?: { host_ip: string; target: number; published: string }[];
  expose?: string[];
  environment: Record<string, string>;
  volumes?: { type: string; source: string; target: string }[];
  build?: { context?: string; dockerfile?: string };
};
function resolve(development: boolean): Record<string, Service> {
  const args = ["compose", "-f", "docker-compose.yml"];
  if (development) args.push("-f", "docker-compose.dev.yml");
  args.push("config", "--format", "json");
  return JSON.parse(
    execFileSync("docker", args, {
      encoding: "utf8",
      windowsHide: true,
      env: {
        ...process.env,
        APP_ORIGIN: "https://maildock.example.test",
        POSTGRES_PASSWORD: "f9-disposable-placeholder",
        AUTH_SECRET: Buffer.alloc(32, 1).toString("base64"),
        CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString("base64"),
      },
    }),
  ).services;
}

it("F9 resolved base Compose keeps two services, internal HTTP and no host publications", () => {
  const services = resolve(false);
  expect(Object.keys(services).sort()).toEqual(["app", "postgres"]);
  expect(services.app.ports ?? []).toEqual([]);
  expect(services.postgres.ports ?? []).toEqual([]);
  expect(services.app.expose).toContain("3000");
  expect(services.app.environment.MAILDOCK_ENV).toBe("production");
  expect(services.app.environment.NODE_ENV).toBe("production");
  expect(services.app.environment.DATABASE_URL).toContain("@postgres:5432/");
  expect(Object.keys(services.app.environment).sort()).toEqual(
    [
      "APP_ORIGIN",
      "ATTACHMENTS_PATH",
      "AUTH_SECRET",
      "CREDENTIALS_ENCRYPTION_KEY",
      "CREDENTIALS_ENCRYPTION_KEY_ID",
      "CREDENTIALS_ENCRYPTION_PREVIOUS_KEYS",
      "DATABASE_URL",
      "MAILDOCK_BOOTSTRAP_SECRET",
      "MAILDOCK_ENV",
      "NODE_ENV",
    ].sort(),
  );
  expect(services.postgres.build).toEqual(
    expect.objectContaining({ dockerfile: "Dockerfile.postgres" }),
  );
  expect(services.postgres.volumes ?? []).toEqual([
    expect.objectContaining({
      type: "volume",
      target: "/var/lib/postgresql",
    }),
  ]);
});

it("F9 resolved development Compose explicitly selects development and loopback publications", () => {
  const services = resolve(true);
  expect(services.app.environment.MAILDOCK_ENV).toBe("development");
  expect(services.app.ports).toEqual([
    expect.objectContaining({
      host_ip: "127.0.0.1",
      target: 3000,
      published: "3000",
    }),
  ]);
  expect(services.postgres.ports).toEqual([
    expect.objectContaining({
      host_ip: "127.0.0.1",
      target: 5432,
      published: "5432",
    }),
  ]);
});
