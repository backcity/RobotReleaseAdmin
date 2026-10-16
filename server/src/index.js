import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = await createApp(config);
const server = app.listen(config.port, () => {
  console.log(`发布管理 http://localhost:${config.port}`);
});
server.requestTimeout = 0;
server.headersTimeout = 0;
