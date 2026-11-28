#!/bin/zsh
set -eu

app=${T3_INFOBAR_APP:-'/Applications/T3 Code (Beta).app'}
port=${T3_INFOBAR_PORT:-9342}
endpoint="http://127.0.0.1:$port/json/version"

debugging_ready() {
  /usr/bin/curl --silent --fail --max-time 1 "$endpoint" >/dev/null
}

if [[ "$(/usr/bin/osascript -e 'application id "com.t3tools.t3code" is running')" == true ]]; then
  if debugging_ready; then
    exec /usr/bin/open -a "$app"
  fi
  /usr/bin/osascript -e 'display dialog "请用 ⌘Q 完全退出 T3 Code，然后重新打开「T3 Code + InfoBar」。" with title "T3 InfoBar" buttons {"好"} default button "好"'
  exit 1
fi

/bin/launchctl kickstart "gui/$(/usr/bin/id -u)/local.t3.infobar" 2>/dev/null || true
/usr/bin/env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS /usr/bin/open -a "$app" \
  --args --remote-debugging-address=127.0.0.1 "--remote-debugging-port=$port"

for attempt in {1..40}; do
  if debugging_ready; then
    exit 0
  fi
  /bin/sleep 0.25
done

print -u2 "T3 Code 未开启 InfoBar 调试端口 $port。"
exit 1
