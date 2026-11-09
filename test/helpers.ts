import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../src/config.js';

/**
 * A complete Config for tests, overridable per case.
 *
 * 🔴 THE SSH HOSTS MUST NEVER NAME A REAL MACHINE.
 *
 * `.invalid` is reserved by RFC 2606 and can never resolve. This is not tidiness:
 * these hosts said `hp` and `hp-readonly` until a test that threaded its exec
 * stub through `ctx.exec` was combined with a tool that had lost that threading
 * — and the tool fell back to the real `execFile`, ssh'd to the real homelab, and
 * **restarted sonarr for real**. The stub was correct; the seam had a hole; and
 * the config decided whether that hole pointed at production or at nothing.
 *
 * A test's blast radius should not depend on every tool remembering to honour a
 * test seam. Point the config at nowhere, and the worst a missed seam can do is
 * fail to resolve.
 */
export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    ownerHandle: '+18015550123',
    kindleSenders: [],
    shellSshHost: 'shell-host.invalid',
    adminSshHost: 'admin-host.invalid',
    shellIdentityShared: false,
    allowSharedSshIdentity: false,
    llm: { provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'test-model' },
    jellyfin: { baseUrl: 'http://jellyfin.test/jellyfin', apiKey: 'test-key' },
    bluebubbles: {
      baseUrl: 'http://bluebubbles.invalid:1234',
      password: 'test-pw',
      expectedIdentity: 'test@invalid',
      host: '127.0.0.1',
      port: 0,
      path: '/webhook',
      publicUrl: 'http://127.0.0.1:0/webhook',
    },
    // Small on purpose: a test that has to build a 12 MB buffer to reach the
    // ceiling is a test nobody writes.
    images: { maxWidth: 1024, maxBytes: 1000, maxCount: 3, historyTurns: 2 },
    kindle: { smtpHost: 'smtp.invalid', smtpPort: 587, fromEmail: 'jedd@invalid', smtpPassword: 'test-pw' },
    // Disabled unless a test sets a URL and key. Usenet rows are then held, not fetched.
    sabnzbd: {
      baseUrl: '',
      apiKey: '',
      category: 'jedd-ebooks',
      storagePrefix: '',
      localDir: '',
    },
    ebookRecheckMs: 30_000,
    prowlarr: { baseUrl: 'http://prowlarr.invalid:9696', apiKey: 'test-key' },
    /**
     * 🔴 `.invalid` FOR THE SAME REASON THE SSH HOSTS ARE. A book test that
     * forgets to stub the catalogue then fails to RESOLVE rather than reaching
     * the real openlibrary.org — and the tool's documented fallback for an
     * unreachable catalogue is to hand back the list and ask, so such a test
     * still exercises a real path instead of silently going to the network.
     */
    openLibrary: { baseUrl: 'http://openlibrary.invalid' },
    sonarr: { baseUrl: 'http://sonarr.invalid:8989/sonarr/api/v3', apiKey: 'test-key', rootFolder: '/tv', qualityProfileId: 9 },
    radarr: { baseUrl: 'http://radarr.invalid:7878/radarr/api/v3', apiKey: 'test-key', rootFolder: '/movies', qualityProfileId: 6 },
    plex: { baseUrl: '', token: '' },
    dispatcharr: { baseUrl: 'http://dispatcharr.test:9191' },
    // Non-empty so `whats_popular` is REGISTERED in tests. It is never used as a
    // credential: every test routes a stub fetch, and the client only ever talks
    // to api.themoviedb.org, which no test is permitted to reach.
    tmdb: { readToken: 'test-read-token' },
    qbittorrent: { baseUrl: 'http://qbittorrent.invalid:8080', lanUrl: 'http://qbit-lan.invalid:8080' },
    jfago: {
      baseUrl: 'http://jfa-go.invalid:8056',
      inviteBaseUrl: 'https://jf.invalid/accounts',
      username: 'u',
      password: 'test-pw',
      profile: 'Default',
      validityHours: 24,
    },
    audiobookshelf: {
      baseUrl: 'http://abs.invalid:13378',
      apiKey: 'test-abs-key',
      publicUrl: 'http://abs.invalid:13378',
    },
    readOnly: true,
    // ⚠️ A TEMP PATH, NEVER the real backup directory. A test that exercised
    // `remove` against the default would write captured indexer definitions —
    // credentials included — into the user's real ~/.superbot2 backups.
    indexerBackupDir: join(mkdtempSync(join(tmpdir(), 'jedd-test-indexer-backup-')), 'captures'),
    downloadBackupDir: join(mkdtempSync(join(tmpdir(), 'jedd-test-download-backup-')), 'captures'),
    // The real default, so assertions on user-facing text keep reading as the
    // shipped product rather than as a placeholder.
    // Tests assume a fully-configured homelab unless they say otherwise; the
    // absent case is exercised explicitly in optional-dependencies.test.ts.
    homelabSshConfigured: true,
    // Tests assume a fully-stocked homelab unless they say otherwise; the absent
    // cases are exercised explicitly in service-gating.test.ts.
    services: {
      sonarr: true,
      radarr: true,
      prowlarr: true,
      jellyfin: true,
      plex: false,
      audiobookshelf: true,
      qbittorrent: true,
      dispatcharr: true,
    },
    displayName: 'Jedd',
    audiobook: { savePath: '/downloads/audiobooks', category: 'audiobooks' },
    checkStreamsResultsPath: '/tmp/check-streams-results.txt',
    // 🔴 SAME RULE AS THE SSH HOSTS ABOVE: never name a real network. A test
    // whose exec seam has a hole must fail to resolve, not connect to a live
    // IRC server and join a real channel under a real nick.
    irc: { host: 'irc.invalid', port: 6667, channel: '#test', nick: 'testbot' },
    ...overrides,
  };
}
