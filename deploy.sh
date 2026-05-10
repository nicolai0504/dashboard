#!/bin/bash
set -e

PI="nico@100.99.118.2"
REMOTE="~/dashboard"

echo "→ Kopierer filer til Pi..."
scp index.html server.js package.json "$PI:$REMOTE/"

echo "→ Kopierer public/..."
scp -r public "$PI:$REMOTE/"

echo "→ Installerer avhengigheter..."
ssh "$PI" "cd $REMOTE && npm install --omit=dev --silent"

echo "→ Starter dashboard på nytt..."
ssh "$PI" "sudo systemctl restart dashboard"

echo "✓ Ferdig — http://100.99.118.2:3000"
