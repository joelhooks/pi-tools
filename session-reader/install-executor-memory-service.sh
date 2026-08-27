#!/bin/sh
set -eu

label="com.joel.session-recall-mcp"
plist="$HOME/Library/LaunchAgents/$label.plist"
wrapper="$HOME/.local/libexec/session-recall-mcp-http"
logs="$HOME/.joelclaw/logs"
secret_name="session_recall_mcp_bearer_token"
uid=$(id -u)

case "${1:-}" in
  install)
    release_root=${2:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}
    node_bin=${NODE_BIN:-$(command -v node)}
    secrets_bin=${SECRETS_BIN:-$(command -v secrets)}
    curl_bin=${CURL_BIN:-$(command -v curl)}
    server_source="$release_root/session-reader/mcp-http-server.ts"
    wrapper_stage="$wrapper.new.$$"
    plist_stage="$plist.new.$$"
    wrapper_backup="$wrapper.backup.$$"
    plist_backup="$plist.backup.$$"
    old_wrapper=false
    old_plist=false
    old_running=false
    rollback_needed=false

    finish() {
      status=$?
      trap - EXIT
      if [ "$rollback_needed" = true ]; then
        launchctl bootout "gui/$uid/$label" >/dev/null 2>&1 || true
        if [ "$old_wrapper" = true ]; then mv "$wrapper_backup" "$wrapper"; else rm -f "$wrapper"; fi
        if [ "$old_plist" = true ]; then mv "$plist_backup" "$plist"; else rm -f "$plist"; fi
        if [ "$old_running" = true ] && [ -f "$plist" ]; then
          launchctl bootstrap "gui/$uid" "$plist" || true
        fi
      fi
      rm -f "$wrapper_stage" "$plist_stage" "$wrapper_backup" "$plist_backup"
      exit "$status"
    }
    trap finish EXIT
    trap 'exit 1' HUP INT TERM

    test -f "$server_source"
    token=$("$secrets_bin" lease "$secret_name" --ttl 1m)
    token_bytes=$(printf %s "$token" | wc -c | tr -d ' ')
    unset token
    if [ "$token_bytes" -lt 32 ]; then
      printf 'agent-secrets entry %s must contain at least 32 bytes\n' "$secret_name" >&2
      exit 1
    fi

    "$node_bin" --input-type=module -e \
      'import { pathToFileURL } from "node:url"; const source = process.argv[1]; process.argv[1] = "installer-validation"; await import(pathToFileURL(source).href)' \
      "$server_source"

    mkdir -p "$(dirname "$wrapper")" "$HOME/Library/LaunchAgents" "$logs"
    cat >"$wrapper_stage" <<EOF
#!/bin/sh
set -eu
TOKEN="\$("$secrets_bin" lease "$secret_name" --ttl 24h)"
exec env NODE_ENV=production SESSION_RECALL_MCP_TOKEN="\$TOKEN" SESSION_RECALL_MCP_PORT=4792 "$node_bin" "$server_source"
EOF
    chmod 700 "$wrapper_stage"
    cat >"$plist_stage" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array><string>$wrapper</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$logs/session-recall-mcp.log</string>
  <key>StandardErrorPath</key><string>$logs/session-recall-mcp.error.log</string>
</dict>
</plist>
EOF
    plutil -lint "$plist_stage" >/dev/null

    if [ -f "$wrapper" ]; then cp -p "$wrapper" "$wrapper_backup"; old_wrapper=true; fi
    if [ -f "$plist" ]; then cp -p "$plist" "$plist_backup"; old_plist=true; fi
    if launchctl print "gui/$uid/$label" >/dev/null 2>&1; then old_running=true; fi

    rollback_needed=true
    mv "$wrapper_stage" "$wrapper"
    mv "$plist_stage" "$plist"
    launchctl bootout "gui/$uid/$label" >/dev/null 2>&1 || true

    activation_ok=false
    if launchctl bootstrap "gui/$uid" "$plist"; then
      attempt=0
      while [ "$attempt" -lt 20 ]; do
        if "$curl_bin" --fail --silent --max-time 1 \
          http://127.0.0.1:4792/healthz >/dev/null; then
          activation_ok=true
          break
        fi
        attempt=$((attempt + 1))
        sleep 0.25
      done
    fi

    if [ "$activation_ok" != true ]; then
      printf 'session recall MCP activation failed; restoring previous service\n' >&2
      exit 1
    fi

    rollback_needed=false
    rm -f "$wrapper_backup" "$plist_backup"
    ;;
  uninstall)
    launchctl bootout "gui/$uid/$label" >/dev/null 2>&1 || true
    rm -f "$plist" "$wrapper"
    ;;
  *)
    printf 'usage: %s install|uninstall [release-root]\n' "$0" >&2
    exit 2
    ;;
esac
