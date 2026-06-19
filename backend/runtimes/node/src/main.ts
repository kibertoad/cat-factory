import { start } from './server.js'

// Default entrypoint: `pnpm build` then `node dist/main.js`. Configuration is read
// from process env (see loadNodeConfig); set PORT to override the listen port.
start()
