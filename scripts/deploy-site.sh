#!/bin/sh
# Deploys the Mason website (site/) to Vercel production. This is the only production deploy Claude is
# pre-approved to run (see the permission rule in ~/.claude/settings.json); everything else still asks.
set -e
cd "$(dirname "$0")/../site"
vercel deploy --prod --yes
