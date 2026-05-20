# @olegbalbekov/openclaw-max

MAX messenger (max.ru) channel plugin for [OpenClaw](https://github.com/openclaw/openclaw).

> **Requires OpenClaw ≥ 2026.3.24**

## Features

- DM and group chat support
- Long polling (default) and webhook modes
- Streaming replies with typing indicator
- Media sending and receiving (images)
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
| `token` | string | required | MAX Bot API token |
| `enabled` | boolean | `true` | Enable/disable channel |
| `dmPolicy` | string | `"allowlist"` | DM access policy: `open`, `allowlist`, `closed` |
| `allowFrom` | string[] | `[]` | MAX user IDs allowed to DM (when dmPolicy=allowlist) |
| `groupPolicy` | string | `"allowlist"` | Group chat access policy: `open`, `allowlist`, `closed` |
| `groupAllowFrom` | string[] | `[]` | MAX user IDs allowed in group chats (when groupPolicy=allowlist) |
| `webhookUrl` | string | — | Webhook URL (optional, uses long polling if not set) |
| `webhookSecret` | string | — | Webhook secret for request verification |

## Webhook mode (optional)

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

- Check that OpenClaw version is ≥ 2026.3.24 (`openclaw --version`)
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
