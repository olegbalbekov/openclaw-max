/**
 * @openclaw/max — MAX messenger channel plugin for OpenClaw
 * https://github.com/olegbalbekov/openclaw-max
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/max";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/max";
import { createMaxPlugin } from "./src/channel.js";
import { setMaxRuntime } from "./src/runtime.js";

const plugin = {
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
