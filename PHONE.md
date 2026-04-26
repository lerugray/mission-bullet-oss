# Phone access — mission-bullet

Walking skeleton for journaling from your phone. Your desktop runs a
small HTTP server; your phone's browser (or a future Capacitor-wrapped
app) talks to it. Same renderer bundle, same files on disk, same git
sync behavior.

**This is not multi-user.** Single journal, single user, localhost or
tailnet only. The server has no authentication. Do not expose to the
public internet.

## One-time setup

### 1. Start the server on your desktop

```bash
cd ~/mission-bullet
bun run ui:serve
```

Default port is `4173` and the server binds to all interfaces (`0.0.0.0`)
so LAN and Tailscale can reach it. Output:

```
[mb-server] listening on http://0.0.0.0:4173
[mb-server] project: /home/you/mission-bullet
[mb-server] entries: /home/you/mission-bullet/entries
[mb-server] open in any browser; expose via Tailscale for phone
```

Leave that terminal open while you want phone access. Closing it stops
the server (and the desktop can still use `bun run ui` in parallel —
both read the same `entries/` directory).

### 2. Set up Tailscale (once)

Install Tailscale on both machines (desktop and phone), sign in with
the same account. Your desktop will have a MagicDNS name like
`my-desktop.tailxxxx.ts.net` that only your own devices can resolve.

Tailscale is free for personal use. Install pages:
- Windows: https://tailscale.com/download/windows
- Android: Play Store "Tailscale"
- iOS: App Store "Tailscale"

### 3. Allow the port through your firewall

On Windows the first time the server starts, Windows Defender may prompt
to allow Bun on private/public networks. Choose private if your phone's
on the same Wi-Fi; otherwise Tailscale tunnels around it anyway.

## Daily use from phone

1. Start the server on desktop: `bun run ui:serve`.
2. On phone, open Chrome: `http://<your-tailscale-hostname>:4173`.
3. First time: Chrome menu → "Add to Home screen" for a PWA-style icon.
4. Tap the icon. Same UI as desktop. Capture, edit, migrate — all works.

## Known limitations (walking skeleton)

- **Offline-hostile.** Desktop must be powered on and Tailscale connected,
  or the phone can't read/write. Bullet journaling can tolerate that —
  if you're offline, capture in your phone's native notes and transcribe
  later. Offline-first is a deliberate non-feature here.
- **Git auth lives on desktop.** The server's auto-commit + push uses
  whatever git credentials are configured on the desktop. The phone
  never touches git directly. If the push fails, the desktop terminal
  logs it under `[mb-server-sync ...]`.
- **TweaksPanel + Mobile preview tab hidden.** Those are desktop-only
  design surfaces. Phone users see just Daily / Sketch / Weekly /
  Monthly / Themes + the Migrate button.
- **Not wrapped as a native app yet.** Capacitor packaging is the next
  phase; the PWA install-to-home-screen is close enough for now.

## Troubleshooting

**"Can't reach the server from my phone."**
- Is the server still running on desktop? Check the terminal.
- Is Tailscale connected on both devices? Open the Tailscale app on
  your phone and confirm the desktop is listed with a green dot.
- Try `http://<tailscale-hostname>:4173` in desktop browser first —
  if that works, desktop's fine and it's a Tailscale/routing issue.

**"Save failed" banner on phone.**
- The server may have restarted (losing git-sync state briefly).
  Try again; writes are idempotent for the most part.
- Check desktop terminal for error logs — any `[mb-server-sync ...]`
  lines with "failed" tell you whether it's a file I/O or git issue.

**Weird text encoding issues.**
- Make sure the desktop's `entries/` directory is UTF-8. The server
  reads/writes UTF-8 unconditionally; CRLF vs LF is tolerated.

## What's not here (yet)

- Voice-to-text capture (coming in a later phase).
- Native Capacitor Android build.
- Offline mode with local git on the phone.
- Per-device session markers in `sessions` frontmatter (everything
  looks the same whether captured on desktop or phone).
