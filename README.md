# @openclaw/max

MAX messenger (max.ru) channel plugin for [OpenClaw](https://openclaw.ai).

Connect your OpenClaw AI assistant to [MAX](https://max.ru) — the Russian messenger by VK. Supports direct messages and group chats via the MAX Bot API.

## Install

```bash
openclaw plugins install @olegbalbekov/openclaw-max
```

## Setup

### 1. Create a MAX bot

1. Register at [business.max.ru](https://business.max.ru/self) as a legal entity or sole proprietor (required by MAX platform)
2. Create a bot and wait for moderation
3. Get your bot token from **Чат-боты → Интеграция → Получить токен**

### 2. Configure OpenClaw

Add to your OpenClaw config:

```json5
{
  channels: {
    max: {
      enabled: true,
      token: "YOUR_BOT_TOKEN",
      dmPolicy: "allowlist",
      allowFrom: ["12345678"]  // your MAX user ID
    }
  }
}
```

Or via environment variable:

```bash
MAX_BOT_TOKEN=your_token_here
```

### 3. (Optional) Webhook mode

For production deployments, configure a webhook URL (requires HTTPS on port 443):

```json5
{
  channels: {
    max: {
      token: "YOUR_BOT_TOKEN",
      webhookUrl: "https://yourdomain.com/max/webhook",
      webhookSecret: "your_random_secret",
      dmPolicy: "open"
    }
  }
}
```

Without `webhookUrl`, the plugin falls back to **long polling** — which works fine for personal use and development.

## Config reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `token` | string | — | **Required.** MAX bot token |
| `enabled` | boolean | `true` | Enable/disable the channel |
| `webhookUrl` | string | — | Public HTTPS URL for webhook delivery |
| `webhookSecret` | string | — | Secret for `X-Max-Bot-Api-Secret` header validation |
| `webhookPath` | string | `/max/webhook` | Internal gateway route path |
| `dmPolicy` | string | `pairing` | DM access policy: `open` / `allowlist` / `pairing` / `disabled` |
| `allowFrom` | string[] | `[]` | Allowlisted MAX user IDs |

### DM policies

- `open` — anyone can message the bot
- `allowlist` — only users in `allowFrom` can message
- `pairing` — new users receive a pairing code; approve with `openclaw pairing approve max <code>`
- `disabled` — no DMs accepted

## Finding your MAX user ID

Send any message to your bot, then check the OpenClaw logs — the sender's `user_id` is logged with each message.

## Multiple accounts

```json5
{
  channels: {
    max: {
      accounts: {
        personal: {
          token: "TOKEN_1",
          dmPolicy: "allowlist",
          allowFrom: ["12345678"]
        },
        business: {
          token: "TOKEN_2",
          dmPolicy: "open"
        }
      }
    }
  }
}
```

## Limitations

- Media attachments: not yet supported (text only)
- Reactions: not supported by MAX Bot API
- Message editing: not supported

## Contributing

PRs welcome! See [CONTRIBUTING.md](./CONTRIBUTING.md).

## Sponsors

Supported by [Evrone](https://evrone.com/?utm_source=openclaw-max) — a software development company that builds products and helps companies improve their development processes.

<a href="https://evrone.com/?utm_source=openclaw-max">
  <img src="https://user-images.githubusercontent.com/417688/34437029-dbfe4ee6-ecab-11e7-9d80-2b274b4149b3.png"
       alt="Sponsored by Evrone" width="231" />
</a>

## License

MIT © [Oleg Balbekov](https://github.com/olegbalbekov)
