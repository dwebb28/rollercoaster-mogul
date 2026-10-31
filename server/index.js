import { loadConfig } from './config.js';
import { createApp } from './app.js';

const config = loadConfig();
const app = createApp(config);

app.listen(config.port, () => {
  console.log(`Rollercoaster Mogul running at ${config.baseUrl}`);
  if (config.devLogin) console.log('Dev login is enabled (disable with ENABLE_DEV_LOGIN=false).');
});
