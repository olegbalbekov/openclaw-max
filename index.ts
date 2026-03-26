/**
 * @openclaw/max — MAX messenger channel plugin for OpenClaw
 * https://github.com/olegbalbekov/openclaw-max
 */

import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { createMaxPlugin } from "./src/channel.js";
import { setMaxRuntime, getMaxRuntime } from "./src/runtime.js";

export { createMaxPlugin as maxPlugin };
export { setMaxRuntime, getMaxRuntime };

export default defineChannelPluginEntry({
  id: "max",
  name: "MAX",
  description: "MAX messenger (max.ru) channel plugin for OpenClaw",
  plugin: createMaxPlugin(),
  setRuntime: setMaxRuntime,
});
