import { start } from './server'

// Default entrypoint for `node dist/main.js` / `tsx src/main.ts`. Configuration is
// read from process env (see loadNodeConfig); set PORT to override the listen port.
start()
