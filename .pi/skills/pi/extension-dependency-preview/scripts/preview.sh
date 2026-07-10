#!/usr/bin/env bash
set -u

PI_HOME="${PI_HOME:-$HOME/pi}"
PI_AGENT_HOME="${PI_AGENT_HOME:-$HOME/.pi/agent}"

printf 'settings roots\n'
rg -n '"('"$PI_HOME"'/extensions/[^"]+\.ts|\.\.?/[^"]+\.ts|~/pi/extensions/[^"]+\.ts)"' "$PI_AGENT_HOME/settings.json" .pi/settings.json 2>/dev/null || true

printf '\nmarkers\n'
cur="$PWD"
while [ "$cur" != "/" ]; do
	[ -e "$cur/.pi/disable-preset" ] && echo "$cur/.pi/disable-preset"
	cur=$(dirname "$cur")
done

printf '\nextension edges\n'
rg -n '^\s*(const\s+[A-Z_]+(\s*:\s*[^=]+)?\s*=\s*"[^"]+\.(ts|json)"|const\s+[A-Z_]+(\s*:\s*[^=]+)?\s*=\s*new URL\("[^"]+\.(ts|json)"|await\s+load\s*\(|await\s+loadMany\s*\(|"extensions"\s*:|"\.\.?/[^"]+\.(ts|json)")' "$PI_HOME/extensions" \
	-g '*.ts' -g '*.json' -g '!node_modules' -g '!package-lock.json'
