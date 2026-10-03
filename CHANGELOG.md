# Changelog

All notable changes to `@olegbalbekov/openclaw-max` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.1] - 2026-10-03

### Added
- **Outbound media uploads against current OpenClaw cores.** Restores sending
  images/files through the current upload flow. (#8)

### Fixed
- **Media and voice in agent replies after 0.7.0.** The inbound reply path now
  passes `mediaReadFile` into `createStreamingDeliver` (backed by
  `runtime.media.loadWebMedia`), so images and voice in replies to incoming
  messages keep working instead of failing with `MAX outbound media requires
  OpenClaw mediaReadFile`. Adds regression tests for PNG and OGG/voice replies.
  (#8, review by @Shagrat2, fix by @Pe4atnik)

## [0.7.0] - 2026-09-29

### Added
- **Media and voice delivery in agent replies.** Outgoing images and audio are
  now sent alongside the reply while the text answer is kept intact, and the turn
  is drafted the same way as the Telegram channel. (#5)
- **Bot token as a SecretRef.** `token` (at the channel level or per account) can
  be a SecretRef resolved at startup from an environment variable, a file (Docker/
  Kubernetes secrets), or an external secret manager via an `exec` provider. A
  plain string token keeps working. If a reference cannot be resolved, the account
  is marked unavailable and the plugin does not start it. (#9)
- Test suite (vitest) with coverage gates and CI.

### Changed
- **Resilient long polling.** Updates are processed in order and a failed update
  is retried up to three times before the batch marker is left unchanged; a later
  poll can redeliver the batch. This favors no message loss — handlers should stay
  idempotent where possible. Update-handler failures are now isolated from
  transport retry/backoff. (#7)

## [0.6.0] - 2026-09-21

- Runs on OpenClaw 2026.8+ cores: no longer calls the removed legacy APIs.
- README refresh.

[0.7.1]: https://github.com/olegbalbekov/openclaw-max/releases/tag/v0.7.1
[0.7.0]: https://github.com/olegbalbekov/openclaw-max/releases/tag/v0.7.0
[0.6.0]: https://github.com/olegbalbekov/openclaw-max/releases/tag/v0.6.0
