import { describe, expect, it } from 'vitest';
import { renderPlist, SERVICE_LABEL } from './launchd.js';

describe('renderPlist', () => {
  it('runs factory daemon with the installing shell PATH, keeps it alive and logs to ~/.ai-factory/logs', () => {
    const plist = renderPlist({
      node: '/opt/node/bin/node',
      factoryRoot: '/Users/n/dev/ai-factory',
      factoryHome: '/Users/n/.ai-factory',
      path: '/opt/homebrew/bin:/usr/bin',
    });
    expect(plist).toContain(`<string>${SERVICE_LABEL}</string>`);
    expect(plist).toContain(
      [
        '    <string>/opt/node/bin/node</string>',
        '    <string>--import</string>',
        '    <string>tsx</string>',
        '    <string>/Users/n/dev/ai-factory/daemon/cli/main.ts</string>',
        '    <string>daemon</string>',
      ].join('\n'),
    );
    expect(plist).toContain('<key>PATH</key>\n    <string>/opt/homebrew/bin:/usr/bin</string>');
    expect(plist).toContain('<key>KeepAlive</key>\n  <true/>');
    expect(plist).toContain('<string>/Users/n/.ai-factory/logs/daemon.log</string>');
  });

  it('escapes XML in paths', () => {
    expect(
      renderPlist({ node: 'n', factoryRoot: '/a&b', factoryHome: '/h', path: '<p>' }),
    ).toContain('<string>/a&amp;b</string>');
  });
});
