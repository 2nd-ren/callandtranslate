import logger from "./middleware/logger.js";
import app from "./app.js";
import { attachXaiSttStreamProxy } from "./utils/xaiSttStreamProxy.js";

const port = process.env.PORT || 3005;
const server = app.listen(port, "127.0.0.1", () => {
  logger.info(`Listening on port ${port}...`);
  console.log(`Listening on port ${port}...`);
});

attachXaiSttStreamProxy(server);

export default server;
