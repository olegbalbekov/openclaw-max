/**
 * @openclaw/max — MAX messenger channel plugin for OpenClaw
 * https://github.com/olegbalbekov/openclaw-max
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/synology-chat";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/synology-chat";
import { createMaxPlugin } from "./src/channel.js";
import { setMaxRuntime } from "./src/runtime.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const plugin: any = {
  id: "max",
  name: "MAX",
  description: "MAX messenger (max.ru) channel plugin for OpenClaw",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setMaxRuntime(api.runtime);
    api.registerChannel({ plugin: createMaxPlugin() });
  },
};

export default plugin;
