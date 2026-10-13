#!/usr/bin/env node
// Signs the built app with your local "Mason Local" certificate, so macOS sees every rebuild as the same app and
// remembers the permissions you've granted (folders, Photos, controlling Terminal). Without a stable signature,
// each build looks brand new and macOS asks all over again.
// The certificate is self-signed and lives only in your login keychain. If it isn't there, this skips signing.
import { execFileSync } from 'node:child_process'

const IDENTITY = 'Mason Local'
const APP = 'dist/mac-arm64/Mason.app'

const identities = execFileSync('security', ['find-identity', '-p', 'codesigning'], { encoding: 'utf8' })
if (!identities.includes(`"${IDENTITY}"`)) {
  console.log(`No "${IDENTITY}" certificate in your keychain; leaving ${APP} with its throwaway signature.`)
  process.exit(0)
}
execFileSync('codesign', ['--force', '--deep', '--sign', IDENTITY, APP], { stdio: 'inherit' })
execFileSync('codesign', ['--verify', '--deep', APP], { stdio: 'inherit' })
console.log(`Signed ${APP} with "${IDENTITY}".`)
