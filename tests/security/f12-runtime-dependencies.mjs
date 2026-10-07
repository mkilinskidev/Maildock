// Opt-in physical final-image inventory and runtime module/patch regression.
// node tests/security/f12-runtime-dependencies.mjs IMAGE [--baseline]
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const image = process.argv[2];
assert.ok(image, "Supply the locally built production image");
const baseline = process.argv.includes("--baseline");
const manifest = JSON.parse(await readFile("package.json", "utf8"));
const probe = `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
const require=createRequire('/app/server.js');
const roots=${JSON.stringify(Object.keys(manifest.dependencies))};
const packages=[];
function scan(dir) {
 if(!fs.existsSync(dir))return;
 for(const e of fs.readdirSync(dir,{withFileTypes:true})) {
  if(!e.isDirectory()||e.isSymbolicLink())continue;
  const p=path.join(dir,e.name);
  if(e.name==='.pnpm'){for(const x of fs.readdirSync(p))scan(path.join(p,x,'node_modules'));continue;}
  if(e.name.startsWith('@')){scan(p);continue;}
  if(!fs.existsSync(path.join(p,'package.json')))continue;
  const m=JSON.parse(fs.readFileSync(path.join(p,'package.json'),'utf8'));
  packages.push({name:m.name,version:m.version,path:p});
  scan(path.join(p,'node_modules'));
 }
}
scan('/app/node_modules');scan('/app/.next/node_modules');
const forbidden=['typescript','vitest','tsx','drizzle-kit','esbuild','@esbuild-kit/esm-loader','@esbuild-kit/core-utils','@vitest/mocker','@vitest/spy','vite','playwright','testcontainers','eslint','prettier','tailwindcss','@tailwindcss/postcss'];
const present=packages.filter(p=>forbidden.includes(p.name));
if(${baseline})for(const name of ['typescript','vitest','tsx','drizzle-kit'])assert.ok(present.some(p=>p.name===name),name);
else assert.deepEqual(present,[],'Build/test payload must be physically absent');
for(const name of roots){assert.ok(fs.existsSync('/app/node_modules/'+name+'/package.json'),name);require.resolve(name==='@lexical/react'?'@lexical/react/LexicalComposer':name);}
for(const name of ['better-auth','better-auth/plugins','@better-auth/utils/otp','@azure/msal-node','pg-boss','postgres','drizzle-orm','imapflow','nodemailer','mailparser','dompurify','jsdom','@node-rs/argon2','next'])await import(name);
const {hash,verify}=await import('@node-rs/argon2');
assert.equal(await verify(await hash('Synthetic F1246 password'),'Synthetic F1246 password'),true);
const files={
 '@better-auth/drizzle-adapter':['dist/index.mjs','and(inArray(idColumn, targetIds), ...clause)'],
 'imapflow':['dist/esm/commands/store.js','ConditionalStoreFailed'],
 'pg-boss':['dist/plans.js','active_job.singleton_key'],
 'next':['dist/server/body-streams.js','NEXT_PROXY_BODY_TOO_LARGE'],
};
for(const [name,[file,marker]]of Object.entries(files)){
 const pkg=packages.find(p=>p.name===name);assert.ok(pkg,name);
 assert.ok(fs.readFileSync(path.join(pkg.path,file),'utf8').includes(marker),'Missing patch: '+name);
}
const imap=packages.find(p=>p.name==='imapflow');
const {default:store}=await import(path.join(imap.path,'dist/esm/commands/store.js'));
const attributes=[];
await assert.rejects(store({state:1,states:{SELECTED:1},enabled:new Set(['CONDSTORE']),mailbox:{noModseq:false},exec:async(cmd,args)=>{attributes.push(...args);return {next(){},response:{attributes:[{section:[{value:'MODIFIED'}]}]}}}},'1',['\\\\Seen'],{uid:true,unchangedSince:0n}),{code:'ConditionalStoreFailed'});
assert.equal(attributes[1][0].value,'UNCHANGEDSINCE');
for(const file of ['dist-worker/composition/recovery-process.js','dist-worker/shared/infrastructure/database/migrate.js','scripts/postgres/maildock-restore-compatibility.sh','scripts/postgres/recovery'])assert.ok(fs.existsSync(file),file);
assert.equal(process.getuid(),1001);assert.equal(process.getgid(),1001);
const size=p=>Number(execFileSync('du',['-sb',p],{encoding:'utf8'}).split(/\\s/)[0]);
console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid(),node:process.version,nodeModulesBytes:size('/app/node_modules'),pnpmBytes:size('/app/node_modules/.pnpm'),physicalPackages:packages.length,productionRoots:roots,confirmedDevelopmentPayload:present,packages:packages.sort((a,b)=>a.path.localeCompare(b.path)),runtimeModules:'PASS',patches:'PASS',argon2:'PASS',conditionalImapStore:'PASS'},null,2));
`;
function docker(args) {
  const r = spawnSync("docker", args, {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(r.status, 0, `docker ${args[0]} failed: ${r.stderr}`);
  return r.stdout;
}
const inventory = JSON.parse(
  docker([
    "run",
    "--rm",
    "--network",
    "none",
    "--entrypoint",
    "node",
    image,
    "--input-type=module",
    "-e",
    probe,
  ]),
);
const metadata = JSON.parse(docker(["image", "inspect", image]))[0];
inventory.imageId = metadata.Id;
inventory.imageBytes = metadata.Size;
await mkdir(".security-results/f12-46", { recursive: true });
await writeFile(
  path.resolve(
    `.security-results/f12-46/${baseline ? "baseline" : "final"}-inventory.json`,
  ),
  JSON.stringify(inventory, null, 2) + "\n",
);
console.log(
  JSON.stringify(
    {
      image,
      imageBytes: inventory.imageBytes,
      nodeModulesBytes: inventory.nodeModulesBytes,
      pnpmBytes: inventory.pnpmBytes,
      physicalPackages: inventory.physicalPackages,
      confirmedDevelopmentPayload: inventory.confirmedDevelopmentPayload.map(
        (p) => `${p.name}@${p.version}`,
      ),
      uid: inventory.uid,
      gid: inventory.gid,
      runtimeModules: inventory.runtimeModules,
      patches: inventory.patches,
    },
    null,
    2,
  ),
);
