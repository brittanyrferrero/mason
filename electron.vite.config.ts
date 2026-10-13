import { execSync } from 'node:child_process'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Where this build came from, so Mason can tell when GitHub has something newer (see src/main/updates.ts).
// A download without git history builds with an empty commit, which turns the update check off.
const commit = (() => {
  try {
    return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    return ''
  }
})()

export default defineConfig({
  main: {
    define: {
      __MASON_REPO__: JSON.stringify(process.cwd()),
      __MASON_COMMIT__: JSON.stringify(commit)
    }
  },
  preload: {},
  renderer: {
    plugins: [react()]
  }
})
