import { readMigrationFiles } from "drizzle-orm/migrator";
import { sql } from "drizzle-orm";
import type { Database } from "./database";

// Compare PostgreSQL's deparsed expressions with the reviewed SQL. PostgreSQL
// expands IN to ANY/ARRAY and inserts casts and redundant grouping parentheses.
const expression = (value: string) => {
  // Preserve literal values and regular expressions exactly while normalizing
  // PostgreSQL's harmless syntax changes around them.
  const literals: string[] = [];
  return value
    .replace(/'(?:[^']|'')*'/g, (literal) => {
      literals.push(literal);
      return `__literal${literals.length - 1}__`;
    })
    .toLowerCase()
    .replace(/"[a-z_]+"\./g, "")
    .replace(/\bin\s*\(([^()]+)\)/g, "=anyarray$1")
    .replace(
      /([a-z_"]+) between ([0-9]+) and ([0-9]+)/g,
      "$1 >= $2 and $1 <= $3",
    )
    .replace(/::(?:text|bigint|integer|boolean)(?:\[\])?/g, "")
    .replace(/[\s"()[\]]/g, "")
    .replace(
      /__literal([0-9]+)__/g,
      (_, index: string) => literals[Number(index)],
    );
};

// Preserve boolean grouping: removing every parenthesis would accept a changed
// AND/OR precedence even when all individual locator predicates remain present.
const checkExpression = (value: string) => {
  const literals: string[] = [];
  const prepared = value
    .replace(/'(?:[^']|'')*'/g, (literal) => {
      literals.push(literal);
      return `__literal${literals.length - 1}__`;
    })
    .toLowerCase()
    .replace(/"[a-z_]+"\./g, "")
    .replace(/"/g, "")
    .replace(
      /([a-z_]+) between ([0-9]+) and ([0-9]+)/g,
      "($1 >= $2 and $1 <= $3)",
    );
  type Node = { operator: "and" | "or"; operands: Node[] } | string;
  const parse = (input: string): Node => {
    let current = input.trim();
    while (current.startsWith("(") && current.endsWith(")")) {
      let depth = 0;
      let outer = true;
      for (let i = 0; i < current.length; i++) {
        if (current[i] === "(") depth++;
        if (current[i] === ")") depth--;
        if (depth === 0 && i < current.length - 1) {
          outer = false;
          break;
        }
      }
      if (!outer) break;
      current = current.slice(1, -1).trim();
    }
    for (const operator of ["or", "and"] as const) {
      const parts: string[] = [];
      let depth = 0,
        start = 0;
      for (const match of current.matchAll(/\(|\)|\band\b|\bor\b/g)) {
        if (match[0] === "(") depth++;
        else if (match[0] === ")") depth--;
        else if (depth === 0 && match[0] === operator) {
          parts.push(current.slice(start, match.index));
          start = match.index + operator.length;
        }
      }
      if (parts.length) {
        parts.push(current.slice(start));
        const operands = parts
          .map(parse)
          .flatMap((node) =>
            typeof node !== "string" && node.operator === operator
              ? node.operands
              : [node],
          );
        return { operator, operands };
      }
    }
    if (/^not\b/.test(current))
      return `not:${JSON.stringify(parse(current.replace(/^not\b/, "")))}`;
    return expression(current);
  };
  return JSON.stringify(parse(prepared)).replace(
    /__literal([0-9]+)__/g,
    (_, index: string) => JSON.stringify(literals[Number(index)]),
  );
};

/** Hash-verified release history remains authority for functions. These extra
 * catalog checks protect native ownership, identity and conditional locators. */
export async function verifyNativeSchema(db: Pick<Database, "execute">) {
  const migration = readMigrationFiles({ migrationsFolder: "db/migrations" })
    .flatMap((m) => m.sql)
    .join("\n");
  const constraints = await db.execute<{
    name: string;
    definition: string;
    valid: boolean;
  }>(sql`
    select c.conname as name, pg_catalog.pg_get_constraintdef(c.oid) as definition, c.convalidated as valid
    from pg_catalog.pg_constraint c join pg_catalog.pg_namespace n on n.oid=c.connamespace
    where n.nspname='public'`);
  const checks = [
    ...migration.matchAll(
      /(?:ADD )?CONSTRAINT "((?:gmail_(?:sync|work)|mail_accounts_(?:work_revision|receive_identity)|mailbox_messages_locator|mailboxes_transport_locator|message_attachments_locator|message_commands_(?:revision_sequence|locator)|messages_native_identity|notification_events_locator)[^"]*)" CHECK \((.+)\)/g,
    ),
  ];
  if (checks.length < 16)
    throw new Error("Native constraint inventory is incomplete.");
  for (const [, name, definition] of checks) {
    const found = constraints.find((c) => c.name === name);
    if (
      !found?.valid ||
      checkExpression(found.definition.replace(/^CHECK /, "")) !==
        checkExpression(definition)
    )
      throw new Error(`Native schema constraint refused: ${name}.`);
  }
  const fks = [
    ...migration.matchAll(
      /ADD CONSTRAINT "([^"]*(?:transport_fk|native_sent_fk))" (FOREIGN KEY [^;]+);/g,
    ),
  ];
  if (fks.length < 10)
    throw new Error("Native ownership inventory is incomplete.");
  for (const [, name, definition] of fks) {
    const found = constraints.find((c) => c.name === name);
    const normalize = (s: string) =>
      s
        .toLowerCase()
        .replace(/"public"\.|public\./g, "")
        .replace(/ on update no action/gi, "")
        .replace(/[\s"]/g, "");
    if (!found?.valid || normalize(found.definition) !== normalize(definition))
      throw new Error(`Native ownership constraint refused: ${name}.`);
  }
  const indexes = await db.execute<{
    name: string;
    definition: string;
    ready: boolean;
  }>(sql`
    select c.relname as name, pg_catalog.pg_get_indexdef(i.indexrelid) as definition, i.indisvalid and i.indisready as ready
    from pg_catalog.pg_index i join pg_catalog.pg_class c on c.oid=i.indexrelid
    join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname='public'`);
  const expectedIndexes = new Map(
    [
      ...migration.matchAll(
        /CREATE UNIQUE INDEX "([^"]*(?:gmail_[^"]*|transport_unique|remote_identity_unique|remote_identity))" (ON [^;]+);/g,
      ),
    ].map(([, name, definition]) => [name, definition]),
  );
  for (const [name, definition] of expectedIndexes) {
    const found = indexes.find((i) => i.name === name);
    const normalize = (s: string) =>
      expression(
        s.replace(/^CREATE UNIQUE INDEX \S+ /i, "").replace(/public\./g, ""),
      );
    if (!found?.ready || normalize(found.definition) !== normalize(definition))
      throw new Error(`Native identity index refused: ${name}.`);
  }
  const [generated] = await db.execute<{
    definition: string;
    kind: string;
  }>(sql`
    select pg_catalog.pg_get_expr(d.adbin,d.adrelid) as definition, a.attgenerated as kind
    from pg_catalog.pg_attribute a join pg_catalog.pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
    where a.attrelid='public.mail_accounts'::regclass and a.attname='receive_transport'`);
  if (
    generated?.kind !== "s" ||
    expression(generated.definition) !==
      expression(
        "case when provider_type = 'gmail_smtp' then 'gmail' else 'imap' end",
      )
  )
    throw new Error("Native generated transport refused.");
}
