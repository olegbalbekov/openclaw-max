# Contributing to @openclaw/max

Thank you for your interest in contributing!

## Development setup

```bash
git clone https://github.com/olegbalbekov/openclaw-max.git
cd openclaw-max
npm install
npm run build
```

## Testing locally with OpenClaw

```bash
openclaw plugins install ./path/to/openclaw-max
```

## Project structure

```
openclaw-max/
├── index.ts              # Plugin entry point
├── src/
│   ├── channel.ts        # Main ChannelPlugin implementation
│   ├── client.ts         # MAX Bot API HTTP client
│   ├── webhook-handler.ts # Inbound webhook handler
│   ├── accounts.ts       # Config / account resolution
│   ├── runtime.ts        # OpenClaw runtime accessor
│   └── types.ts          # TypeScript types for MAX API
├── openclaw.plugin.json  # Plugin manifest
└── package.json
```

## Submitting changes

1. Fork the repo
2. Create a branch: `git checkout -b feat/my-feature`
3. Commit your changes
4. Open a pull request

## MAX API reference

- https://dev.max.ru/docs-api
- https://dev.max.ru/docs/chatbots/bots-coding/prepare
