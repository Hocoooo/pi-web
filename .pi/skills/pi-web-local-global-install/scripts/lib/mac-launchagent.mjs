import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const OWNER = 'pi-web-macos-service-v1';
export function readPrivateJson(file, uid = process.getuid()) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o077) || stat.size > 1024 * 1024) throw new Error();
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } catch { throw new Error('Expected an owner-only regular JSON file (0600), not a symlink'); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
export function readLaunchEnvironment(file, home) {
  const env = readPrivateJson(file);
  if (!env || Array.isArray(env) || typeof env !== 'object' || env.HOME !== home || !env.PATH
    || Object.entries(env).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes('\0'))) {
    throw new Error('LaunchAgent environment must be a string map with the original HOME and an explicit PATH');
  }
  return env;
}
function canonicalPath(file) {
  try { return fs.realpathSync(file); }
  catch (error) {
    if (error.code !== 'ENOENT' || path.dirname(file) === file) throw error;
    return path.join(canonicalPath(path.dirname(file)), path.basename(file));
  }
}
function entryExists(file) {
  try { fs.lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
export function servicePaths(home, prefix, port) {
  const key = crypto.createHash('sha256').update(`${canonicalPath(prefix)}:${port}`).digest('hex').slice(0, 20);
  const label = `com.pi-web.service.${key}`;
  const directory = path.join(home, 'Library', 'Application Support', 'Pi Web', label);
  return { label, directory, config: path.join(directory, 'config.json'), runner: path.join(directory, 'agent-entry.mjs'),
    module: path.join(directory, 'mac-launchagent.mjs'), plist: path.join(home, 'Library', 'LaunchAgents', `${label}.plist`),
    log: path.join(directory, 'service.log') };
}
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
export function launchAgentPlist(config, files) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${xml(files.label)}</string>
<key>ProgramArguments</key><array>${['/usr/bin/env', '-u', 'NODE_OPTIONS', '-u', 'TURBOPACK', config.node, files.runner, files.config].map(arg => `<string>${xml(arg)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xml(config.packageDir)}</string>
<key>LimitLoadToSessionType</key><string>Aqua</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><false/>
<key>ExitTimeOut</key><integer>15</integer>
<key>StandardOutPath</key><string>${xml(files.log)}</string>
<key>StandardErrorPath</key><string>${xml(files.log)}</string>
</dict></plist>\n`;
}
function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o022)) throw new Error('Unsafe LaunchAgent directory');
}
function publish(file, text) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, file);
}

/** No global launchctl env, sudo, keychain reads, or implicit capture of credentials. */
export class LaunchAgent {
  constructor(host, plan) {
    this.host = host;
    this.plan = plan;
    this.files = servicePaths(plan.runtimeHome, plan.prefix, plan.port);
    this.target = `gui/${process.getuid()}/${this.files.label}`;
  }
  existing() {
    const { files, plan } = this;
    if (!entryExists(files.config) && !entryExists(files.plist)) return null;
    const config = readPrivateJson(files.config);
    if (config.owner !== OWNER || config.home !== plan.runtimeHome || config.port !== plan.port
      || config.packageDir !== this.host.packageDir(plan.prefix) || !path.isAbsolute(config.node)
      || !path.isAbsolute(config.envFile) || typeof config.hostname !== 'string') throw new Error('Unrecognized LaunchAgent configuration');
    const stat = fs.lstatSync(files.plist);
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077)
      || fs.readFileSync(files.plist, 'utf8') !== launchAgentPlist(config, files)) throw new Error('Unrecognized LaunchAgent plist; refusing replacement');
    return config;
  }
  loaded() {
    const result = this.host.launchctl(['print', this.target]);
    if (result.status === 113) return null; // launchctl: service not found; other failures are not absence.
    if (result.status !== 0) throw new Error('Cannot inspect LaunchAgent domain');
    const config = this.existing();
    const lines = result.stdout.split('\n').map(line => line.trim());
    if (!config || !lines.includes(this.files.runner) || !lines.includes(this.files.config)) throw new Error('LaunchAgent label is occupied by an unknown job');
    const pid = result.stdout.match(/^\s*pid = (\d+)\s*$/m)?.[1];
    if (pid) {
      const details = this.host.processDetails(Number(pid));
      if (!details.argv.includes(this.files.runner) || !details.argv.includes(this.files.config)) throw new Error('LaunchAgent process identity mismatch');
    }
    return { pid: pid ? Number(pid) : null };
  }
  preflight() {
    const existing = this.existing();
    this.loaded(); // Also refuse an unknown loaded label when there is no owned plist.
    const result = this.host.launchctl(['print', `gui/${process.getuid()}`]);
    if (result.status !== 0) throw new Error('A healthy logged-in GUI launchd domain is required');
    if (this.plan.macosLaunch !== 'launchagent') return;
    const file = this.plan.macosEnvFile ?? existing?.envFile;
    if (!file || !path.isAbsolute(file)) throw new Error('LaunchAgent requires --macos-env-file with an absolute owner-only JSON environment file');
    const env = readLaunchEnvironment(file, this.plan.runtimeHome);
    // Never silently drop the current server password / agent home / required provider credential.
    for (const key of ['PI_WEB_PASSWORD', 'PI_CODING_AGENT_DIR', 'TAPSVC_API_KEY']) {
      if (this.host.runtimeEnv[key] && env[key] !== this.host.runtimeEnv[key]) throw new Error(`LaunchAgent environment differs for ${key}; configure it explicitly before migration`);
    }
    if (existing && existing.envFile !== file) throw new Error('Changing an existing LaunchAgent environment path requires manual migration');
    this.environmentFile = file;
  }
  stop() {
    if (!this.loaded()) return;
    const result = this.host.launchctl(['bootout', this.target]);
    if (result.status !== 0) throw new Error('LaunchAgent bootout failed; no package overwrite permitted');
  }
  disableRegistration() {
    // Called only after authorized stop when migrating back to Terminal. Keep config/logs for diagnosis.
    if (!this.existing()) return;
    if (this.loaded()) throw new Error('LaunchAgent is still loaded');
    fs.unlinkSync(this.files.plist);
    fs.unlinkSync(this.files.config);
  }
  start() {
    this.preflight();
    if (this.loaded()) throw new Error('LaunchAgent must be unloaded before starting');
    const config = { owner: OWNER, node: process.execPath, packageDir: this.host.packageDir(this.plan.prefix),
      home: this.plan.runtimeHome, hostname: this.plan.host, port: this.plan.port, envFile: this.environmentFile };
    privateDirectory(this.files.directory);
    privateDirectory(path.dirname(this.files.plist));
    for (const [target, source] of [[this.files.runner, 'agent-entry.mjs'], [this.files.module, 'mac-launchagent.mjs']]) {
      publish(target, fs.readFileSync(fileURLToPath(new URL(source, import.meta.url)), 'utf8'));
    }
    publish(this.files.config, JSON.stringify(config, null, 2));
    publish(this.files.plist, launchAgentPlist(config, this.files));
    const result = this.host.launchctl(['bootstrap', `gui/${process.getuid()}`, this.files.plist]);
    if (result.status !== 0) throw new Error('LaunchAgent bootstrap failed; inspect its private service.log');
  }
}
