import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import dns from "node:dns/promises";
import { execFile } from "node:child_process";

export interface ServiceHealth {
  status: "healthy" | "degraded" | "unhealthy";
  checks: { user: boolean; dns: boolean; childUser: boolean; childDns: boolean; paths: boolean };
}

async function boundedCheck(check: () => Promise<unknown>, timeout = 3000): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      check().then(() => true, () => false),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeout); }),
    ]);
  } finally { clearTimeout(timer); }
}

export async function checkReadablePaths(paths: string[]): Promise<boolean> {
  if (paths.length > 8 || paths.some(p => typeof p !== "string" || !path.isAbsolute(p))) return false;
  return boundedCheck(async () => {
    for (const file of paths) {
      const stat = await fs.stat(file);
      if (stat.isDirectory()) {
        const directory = await fs.opendir(file);
        try { await directory.read(); } finally { await directory.close(); }
      } else if (stat.isFile()) {
        const handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK);
        try {
          if (!(await handle.stat()).isFile()) throw new Error("File changed");
          await handle.read(Buffer.alloc(1), 0, 1, 0);
        } finally { await handle.close(); }
      } else throw new Error("Not a regular file or directory");
    }
  });
}

// Fixed script; no request-supplied code, hostnames, paths, or credentials are returned.
const CHILD_PROBE = `const os=require('node:os'),dns=require('node:dns');
let user=false;try{user=!!os.userInfo().username}catch{}
let done=false;const finish=dns=>{if(done)return;done=true;process.stdout.write(JSON.stringify({user,dns}),()=>process.exit(0))};
setTimeout(()=>finish(false),2500);dns.lookup(process.argv[1],e=>finish(!e));`;
function checkChild(host: string): Promise<{ user: boolean; dns: boolean }> {
  return new Promise(resolve => {
    execFile(process.execPath, ["-e", CHILD_PROBE, host], { timeout: 4000, maxBuffer: 4096, windowsHide: true }, (error, stdout) => {
      try {
        const result = JSON.parse(stdout);
        resolve({ user: !error && result.user === true, dns: !error && result.dns === true });
      } catch { resolve({ user: false, dns: false }); }
    });
  });
}

export async function inspectServiceHealth(deps = {
  userInfo: os.userInfo, lookup: dns.lookup, child: checkChild, readable: checkReadablePaths,
  env: process.env, home: os.homedir(),
}): Promise<ServiceHealth> {
  let user = false;
  try { user = Boolean(deps.userInfo().username); } catch { /* System user lookup failed. */ }
  const host = deps.env.PI_WEB_HEALTH_DNS_HOST || "github.com";
  let paths: string[] = [deps.home];
  try {
    if (deps.env.PI_WEB_HEALTH_PATHS) {
      const extra: unknown = JSON.parse(deps.env.PI_WEB_HEALTH_PATHS);
      if (!Array.isArray(extra) || extra.some(p => typeof p !== "string")) throw new Error();
      paths = [...paths, ...extra];
    }
  } catch { paths = [""]; }
  const [resolved, child, readable] = await Promise.all([
    boundedCheck(() => deps.lookup(host)), deps.child(host), deps.readable(paths),
  ]);
  const checks = { user, dns: resolved, childUser: child.user, childDns: child.dns, paths: readable };
  return { status: !user || !child.user || !readable ? "unhealthy" : !resolved || !child.dns ? "degraded" : "healthy", checks };
}

let cached: { expires: number; result: Promise<ServiceHealth> } | undefined;
export function serviceHealth(): Promise<ServiceHealth> {
  if (!cached || Date.now() >= cached.expires) cached = { expires: Date.now() + 5000, result: inspectServiceHealth() };
  return cached.result;
}
