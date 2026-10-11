import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const SERVICE_LABEL = 'dk.ai-factory.daemon';

export interface ServiceOptions {
  /** The node binary that runs the daemon. */
  node: string;
  factoryRoot: string;
  /** `~/.ai-factory`: logs go to `<home>/logs/`. */
  factoryHome: string;
  /** PATH for the daemon, so it finds codex, gh and git like the shell that installed it. */
  path: string;
}

const escapeXml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A launchd agent that starts `factory daemon` at login and restarts it if it exits. */
export function renderPlist(options: ServiceOptions): string {
  const args = [
    options.node,
    '--import',
    'tsx',
    join(options.factoryRoot, 'daemon/cli/main.ts'),
    'daemon',
  ];
  const logs = join(options.factoryHome, 'logs');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${escapeXml(a)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(options.factoryRoot)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapeXml(options.path)}</string>
    <key>AI_FACTORY_HOME</key>
    <string>${escapeXml(options.factoryHome)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>${escapeXml(join(logs, 'daemon.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(join(logs, 'daemon.err.log'))}</string>
</dict>
</plist>
`;
}

export function plistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
}

function domain(): string {
  return `gui/${String(process.getuid?.() ?? 501)}`;
}

/** Writes the plist and (re)loads it with launchctl. Returns the plist path. */
export async function installService(options: ServiceOptions): Promise<string> {
  const path = plistPath();
  await mkdir(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
  await mkdir(join(options.factoryHome, 'logs'), { recursive: true });
  await writeFile(path, renderPlist(options));
  await execFileAsync('launchctl', ['bootout', `${domain()}/${SERVICE_LABEL}`]).catch(
    () => undefined,
  );
  await execFileAsync('launchctl', ['bootstrap', domain(), path]);
  return path;
}

export async function uninstallService(): Promise<void> {
  await execFileAsync('launchctl', ['bootout', `${domain()}/${SERVICE_LABEL}`]).catch(
    () => undefined,
  );
  await rm(plistPath(), { force: true });
}
