# Setting up Jedd

Jedd is a bot you text. You send it *"grab season 2 of The Bear"* or *"why is
the TV buffering"*, and it uses your existing homelab — Sonarr, Radarr, Jellyfin,
whatever you actually run — to do the thing and tell you what happened.

It is designed to drop into a stack you already have. **You point it at your
services; it does not install or manage them.**

---

## What you need before you start

**Two things are genuinely required.** Without either, Jedd cannot function at
all, and it will tell you so at startup rather than half-working.

| Required | Why |
|---|---|
| **A BlueBubbles server** on a Mac signed into an iMessage account | This is how Jedd receives and sends messages. There is no other channel. Jedd refuses to start if it cannot reach it. |
| **An LLM endpoint** — [Ollama](https://ollama.com) with a tool-calling model | This is the part that understands what you said. Without it Jedd starts, but every message fails. |

**Everything else is optional.** Jedd looks at your `.env` at startup, works out
what you have configured, and **only offers itself the tools it can actually
use.** A service you do not have is not a broken feature — the capability simply
is not there, and the startup log says which variable would turn it on.

---

## Quickstart

```bash
cp .env.example .env
$EDITOR .env          # fill in the four required values below
docker compose up -d
docker compose logs -f
```

The four values you cannot skip:

```bash
OWNER_HANDLE=+15551234567          # your phone number — this is who gets admin access
JEDD_SEND_TO=+15551234567          # who Jedd may text. See the warning below.
BLUEBUBBLES_IDENTITY=you@icloud.com  # the Apple ID the BlueBubbles server is signed into
BLUEBUBBLES_PASSWORD=...           # your BlueBubbles server password
```

### 🔴 Set `JEDD_SEND_TO` deliberately

There is no default and Jedd **refuses to start** without it. That is on
purpose: the alternative to knowing who it may text is guessing, and the cost of
guessing is that it answers everyone who has ever messaged that Mac.

- `JEDD_SEND_TO=+15551234567` — only this person. Everyone else gets **silence**.
  Start here.
- `JEDD_SEND_TO=everyone` — anyone who texts it. Only once you trust it.

### ⚠️ `localhost` will not work from inside the container

The single most common first-run failure. In a container, `localhost` means
**the container itself**, not the machine running Ollama or BlueBubbles.

```bash
# ❌ these are the defaults, and they cannot work from a container
LLM_BASE_URL=http://localhost:11434
BLUEBUBBLES_URL=http://127.0.0.1:1234

# ✅ Docker Desktop (macOS/Windows)
LLM_BASE_URL=http://host.docker.internal:11434
BLUEBUBBLES_URL=http://host.docker.internal:1234

# ✅ or just use the host's LAN address
LLM_BASE_URL=http://192.0.2.10:11434
```

Jedd checks the model endpoint at startup and says so loudly if it cannot reach
it — including calling out this exact mistake.

---

## What each optional service buys you

Add these only if you run them. Each row is independent: skipping one costs you
that row and nothing else.

| Set this | And you get |
|---|---|
| `SONARR_URL` + `SONARR_API_KEY` | TV: search, add a show, add a season, fill gaps, check download status |
| `RADARR_URL` + `RADARR_API_KEY` | Films: search and add |
| `PROWLARR_URL` + `PROWLARR_API_KEY` | Release search behind the *arrs, audiobook and ebook search, indexer admin |
| `JELLYFIN_URL` + `JELLYFIN_API_KEY` | "What's on my server", who is watching right now |
| `QBITTORRENT_LAN_URL` | Find and clear stuck downloads |
| `TMDB_READ_TOKEN` | "What's popular right now" — neither *arr can browse, they need a title |
| `HP_ADMIN_SSH_HOST` | **12 tools**: docker ps/inspect/logs, restart a container, restart the *arr stack, diagnose host contention, live-TV checks |
| `HP_SHELL_SSH_HOST` | `hp_shell` — free-form read-only shell. See the security note below. |
| `KINDLE_SMTP_*` | **4 tools**: find an ebook and send it to a Kindle, plus address intake |
| `SABNZBD_URL` + `SABNZBD_API_KEY` + `SABNZBD_STORAGE_PREFIX` + `SABNZBD_LOCAL_DIR` | Usenet ebooks: queue an NZB in SABnzbd and mail it when the job completes. Torrent and IRC ebooks work without this |
| `PLEX_URL` + `PLEX_TOKEN` | Say a requested movie or the requested seasons are on Plex, only after a matching guid and a real media file. Posters do not use this |
| `JFAGO_URL` + `JFAGO_PASSWORD` | Invite someone to your Jellyfin |
| `DISPATCHARR_URL` | Live-TV channel health |
| `IRC_EBOOKS=1` | A second ebook source besides Prowlarr |
| `RUNBOOK_PATH` | Lets Jedd read your own homelab notes when diagnosing |

Full descriptions of every variable are in **`.env.example`**, which is the
complete reference — every variable the code reads is documented there.

### Usenet ebooks (SABnzbd)

Torrent grabs still go to qBittorrent over SSH (`EBOOK_HOST_DOWNLOAD_PREFIX`).
IRC grabs are unchanged. Usenet is a third fetcher. It runs only when the
SABnzbd URL, API key, storage prefix, and local directory are all set.

Create a SABnzbd category named `jedd-ebooks` (or whatever `SABNZBD_CATEGORY`
is) with its own folder, not the incomplete directory and not another app's
category. `SABNZBD_STORAGE_PREFIX` is that folder as SABnzbd reports it in
history `storage`. There is no default path.

Jedd does not read the download over SSH. Bind-mount only that category
directory read-only, and set `SABNZBD_LOCAL_DIR` to the path inside Jedd.
Example, not a deployed layout:

```yaml
- /srv/downloads/ebooks:/ebooks:ro
```

```
SABNZBD_STORAGE_PREFIX=/library/ebooks
SABNZBD_LOCAL_DIR=/ebooks
```

Usenet copies are not offered, and nothing is queued, until the URL, the API
key, and both paths are set. A pending ebook is checked about every 30 seconds
(`EBOOK_RECHECK_MS`). Media, throttle, and Kindle-verify follow-ups keep their
own gaps. The ebook watch still lasts about 40 minutes before it says it stopped.

`SABNZBD_URL` is the SABnzbd server root with no `/api` suffix. This repo does
not ship a host or a port for it. A finished job is mailed only after history
says `Completed` and includes a storage path, the file is an EPUB, PDF, or
AZW3 inside that mount, and the existing validator accepts the bytes. The
iMessage says the mail server accepted the file. It does not say the Kindle
device has it. Amazon refusals still come back through the existing IMAP check.

### Movie and show requests

A contested title asks which one, with a number, the year, and a poster when
Radarr or Sonarr returned an allowlisted `remotePoster`. A reply that is only
that number uses the stored row. It does not search again. The first text after
an accepted add is "Your request for Title (Year) has been added." The second,
"Title is now available on Plex.", is sent only after Plex returns that same
tmdb or tvdb id and a media file. A season request names those seasons. An
episode that has not aired yet does not count, and one episode on disk is not
the whole show. If `PLEX_URL` or `PLEX_TOKEN` is empty, Jedd says it cannot
check Plex. It does not call the title available. Posters are fetched only from
`https://image.tmdb.org` and `https://artworks.thetvdb.com`. No TMDB read token
is required for that. A missing poster does not cancel the request.

### 🔴 If you set the two SSH variables, make them different accounts

`HP_ADMIN_SSH_HOST` is privileged (it needs docker). `HP_SHELL_SSH_HOST` is the
account the *model* composes commands for, and it must be **unprivileged — no
docker group, no sudo.**

If they are the same account, that boundary does not exist, and Jedd
**refuses to offer `hp_shell` at all** rather than pretending otherwise. It
verifies this by actually running `id` over both at startup — not by trusting
your config. Leaving `HP_SHELL_SSH_HOST` unset is a perfectly good choice; you
lose one tool.

---

## How to tell it worked

```
[jedd] BlueBubbles 1.9.9 bridging you@icloud.com
[jedd] model OK: http://host.docker.internal:11434 has qwen3:8b
[jedd] SEND AUDIENCE: +15551234567 — everyone else gets SILENCE.
[jedd] tools=library_search, check_status, add_series, ...
[jedd] not configured, so NOT offered (3):
[jedd]   - homelab ssh (12 docker/host tools) — set HP_ADMIN_SSH_HOST
[jedd]   - ebooks to Kindle (4 tools) — set KINDLE_SMTP_PASSWORD
[jedd]   - whats_popular / title_details — set TMDB_READ_TOKEN
[bb] listening on http://0.0.0.0:18796/webhook
```

**That "not configured" block is not an error.** It is Jedd telling you exactly
what it left out and which variable would bring it back. A short tool list with
a clear reason is working correctly.

Now text it from the number in `JEDD_SEND_TO`. Try *"what's on my server?"*

---

## When it does not work

| What you see | What it is |
|---|---|
| Exits immediately, `JEDD_SEND_TO is not set` | Working as designed. Set it — see above. |
| Exits, cannot reach BlueBubbles | Check `BLUEBUBBLES_URL` (the `localhost` trap) and that the server is running. |
| `🔴 THE MODEL IS NOT USABLE` | Ollama unreachable, or `LLM_MODEL` names a model it does not have — the message lists the models it *does* have. |
| Boots fine, you text it, **nothing comes back** | Almost always the send audience: your number is not in `JEDD_SEND_TO`, so you are being deliberately ignored. Check the `SEND AUDIENCE` line. |
| A tool you expected is missing | Read the "not configured" block. It names the variable. |
| Homelab tools all fail | The ssh host is configured but unreachable — check `docker compose logs` for the identity probe, and that the key is mounted and the host is up. |

State lives in `./data` and is bind-mounted, so it survives restarts. Losing it
loses conversation history and any scheduled follow-ups.

---

## The one thing worth understanding

Jedd would rather **not have a capability than have one that fails when you need
it.** That is why a missing service removes tools instead of leaving broken ones
in place: a tool that exists is one the model will offer to a person, and being
promised something that then fails is worse than never being offered it.

So a small tool list is not a degraded install. It is an honest one.
