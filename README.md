# @olegbalbekov/openclaw-max

MAX messenger (max.ru) channel plugin for [OpenClaw](https://github.com/openclaw/openclaw).

## Features

- DM and group chat support
- Resilient long polling (default) and webhook modes: updates are processed in
  order and retried on transient failures, so a dropped connection does not lose
  messages
- Live status updates (Telegram-style): a placeholder reply that shows work in
  progress — thinking, per-tool activity, approval waits — and is cleaned up on
  silent replies
- Media and voice delivery in agent replies (images and audio), sent alongside
  the answer without dropping the text — the turn is drafted the same way as the
  Telegram channel
- Forwarded messages: incoming forwards are unwrapped and passed to the agent
- Media sending and receiving: images (including screenshots and images from
  forwarded messages) plus inbound files, audio, video, and documents are
  downloaded to `~/.openclaw/media/inbound` and the saved path is handed to the
  agent as `[file: <path>]` (`[image: <path>]` for pictures)
- Bot token as a plain string or a [SecretRef](#token-as-a-secretref) (env, file,
  or external secret manager) — the credential can stay out of the config file
- Allowlist-based access control

## Installation

### 1. Install the plugin

```bash
openclaw plugins install @olegbalbekov/openclaw-max
```

Or manually — clone/copy the plugin directory into `~/.openclaw/extensions/max/` and add to your config:

```json5
{
  plugins: {
    load: {
      paths: ["~/.openclaw/extensions/max"]
    },
    entries: {
      max: { enabled: true }
    }
  }
}
```

> **Important:** Do NOT add `plugins.allow` unless you explicitly need it. When `plugins.allow` is set, it acts as a strict allowlist and will block all bundled plugins (including Telegram) that are not listed. Use `plugins.entries` instead to enable/disable individual plugins.

### 2. Get a MAX bot token

1. Go to [business.max.ru](https://business.max.ru) and create a bot
2. Copy the bot token

### 3. Configure OpenClaw

Add to `~/.openclaw/openclaw.json`:

```json5
{
  channels: {
    max: {
      enabled: true,
      token: "YOUR_BOT_TOKEN_HERE",
      dmPolicy: "allowlist",         // "open" | "allowlist" | "closed"
      allowFrom: ["YOUR_USER_ID"],   // MAX user IDs — must be strings
    }
  },
  bindings: [
    {
      agentId: "main",
      match: { channel: "max", accountId: "default" }
    }
  ]
}
```

### 4. Restart the gateway

```bash
sudo systemctl restart openclaw
# or
openclaw gateway restart
```

### 5. Verify

```bash
openclaw channels status
```

Should show: `MAX default: enabled, dm:allowlist, allow:YOUR_USER_ID`

## Configuration reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `token` | string \| SecretRef | required | MAX Bot API token, plain or a SecretRef (see below) |
| `enabled` | boolean | `true` | Enable/disable channel |
| `dmPolicy` | string | `"allowlist"` | DM access policy: `open`, `allowlist`, `closed` |
| `allowFrom` | string[] | `[]` | MAX user IDs allowed to DM (when dmPolicy=allowlist) |
| `groupPolicy` | string | `"allowlist"` | Group chat access policy: `open`, `allowlist`, `closed` |
| `groupAllowFrom` | string[] | `[]` | MAX user IDs allowed in group chats (when groupPolicy=allowlist) |
| `webhookUrl` | string | — | Webhook URL (optional, uses long polling if not set) |
| `webhookSecret` | string | — | Webhook secret for request verification |
| `httpProxy` | string | — | Optional HTTP(S) proxy for MAX API traffic, e.g. `http://user:pass@host:port` |

### Token as a SecretRef

A plain string token keeps working. To keep the credential out of the config file,
`token` (at the channel level or in `accounts.<id>`) can instead be a
[SecretRef](https://docs.openclaw.ai/gateway/config-secrets-env) that the gateway
resolves at startup. Any secret source works; the plugin does not depend on a
particular store.

From an environment variable — works everywhere, no provider setup needed:

```json5
{
  channels: {
    max: {
      token: { source: "env", provider: "default", id: "MAX_BOT_TOKEN" },
    },
  },
}
```

From a file (for example a Docker or Kubernetes secret mounted into the container):

```json5
{
  secrets: {
    providers: {
      maxfile: { source: "file", path: "/run/secrets/max-token", mode: "singleValue" },
    },
  },
  channels: {
    max: {
      token: { source: "file", provider: "maxfile", id: "value" },
    },
  },
}
```

From an external secret manager (Vault, a system keychain, a password manager) through
an `exec` provider: declare a resolver under `secrets.providers` and point the ref at
it, e.g. `{ source: "exec", provider: "vault", id: "max/bot-token" }`. The resolver
speaks OpenClaw's exec protocol — see the
[secret providers](https://docs.openclaw.ai/gateway/config-secrets-env) docs.

If a reference cannot be resolved, the gateway marks the account unavailable and the
plugin does not start it; the log names the unresolved reference. Check with
`openclaw secrets audit`.

## MAX API migration (July 2026)

As of **2026-07-19** MAX decommissioned the legacy `platform-api.max.ru` host. This
plugin (v0.5.0+) talks to the new `platform-api2.max.ru` endpoint. That host serves
a TLS chain anchored on the **Russian Trusted Root CA (Минцифры)**, which is not in
Node's bundled certificate store — so the plugin ships that CA and trusts it
automatically (on top of the default roots). No manual `NODE_EXTRA_CA_CERTS` setup
is required. Bot tokens are sent via the `Authorization` header, as the new API
mandates.

If your gateway has no direct route to `platform-api2.max.ru`, set `httpProxy` to
tunnel all MAX traffic through a proxy.

## OpenClaw 2026.8+ compatibility

Since **v0.6.0** the plugin runs on OpenClaw 2026.8+ cores: it no longer calls the
renamed `config.loadConfig` and derives session keys through the core route
resolver (canonical keys) instead of a flat `max:<senderId>`.

> **Upgrade note:** the session-key change means active MAX dialogs are re-keyed
> once on the first restart after upgrading — ongoing conversations start a fresh
> session history that one time. This is expected, not a bug.

## Webhook mode (optional)

Long polling processes updates in order and retries a failed update up to three
times before leaving the batch marker unchanged. A later poll can therefore
redeliver the batch. This favors no loss, but an update completed before the
failure can be delivered more than once; handlers should remain idempotent where
possible.

For production, configure a webhook instead of long polling:

```json5
{
  channels: {
    max: {
      token: "YOUR_BOT_TOKEN",
      webhookUrl: "https://your-domain.com/api/channels/max/webhook",
      webhookSecret: "your-secret"
    }
  }
}
```

## Troubleshooting

**Plugin not starting / `channels.max: unknown channel id`**

- Make sure `plugins.allow` is NOT set (or includes `"max"` explicitly)

**Telegram stops working after adding MAX**

- Do NOT set `plugins.allow: ["max"]` — this blocks all other plugins including Telegram
- Use `plugins.entries.max.enabled: true` instead

**Gateway won't start**

- Validate config JSON: `python3 -c "import json; json.load(open('~/.openclaw/openclaw.json'))"`
- Check logs: `journalctl -u openclaw -n 50`

## Supported by

Supported by [Evrone](https://evrone.com/?utm_source=openclaw-max) — a software development company that builds products and helps companies improve their development processes.

<a href="https://evrone.com/?utm_source=openclaw-max">
  <img src="https://user-images.githubusercontent.com/417688/34437029-dbfe4ee6-ecab-11e7-9d80-2b274b4149b3.png"
       alt="Sponsored by Evrone" width="231" />
</a>

## License

MIT © [Oleg Balbekov](https://github.com/olegbalbekov)
