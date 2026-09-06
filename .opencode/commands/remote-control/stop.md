---
description: Stop sharing this session (remote control)
---
Run this command, then report ONLY its stdout to the user — nothing else:

```bash
node ~/.agents/skills/remote-control/bin/index.js stop --relay https://opencode.b4tr.net --api-key "$RELAY_API_KEY" --session-id "$1"
```

If the session id is unknown, first run `ps aux | grep remote-control/bin` to find the running bridge and read its session id from the log/output, or ask the user. Stop is idempotent.
