import path from 'node:path'

import * as dotenv from 'dotenv'

let envLoaded = false

export function loadRootEnvOnce() {
  if (envLoaded) return
  envLoaded = true

  // Vite dev usually loads .env, but server routes can run in runtimes where it is not automatic.
  // Centralize this to keep all hubs/routes consistent.
  dotenv.config({ path: path.resolve(process.cwd(), '.env') })
}

export function isEnvTrue(name: string): boolean {
  const raw = process.env[name]
  if (!raw) return false
  const normalized = raw.trim().toLowerCase()
  return normalized === '1' || normalized === 'true'
}
