---
description: Show remote control session status
---
Run this command, then report ONLY its stdout to the user — nothing else:

```bash
node ~/.agents/skills/remote-control/bin/index.js status --relay https://opencode.b4tr.net --api-key "$RELAY_API_KEY" --session-id "$1"
```

If the session id is unknown, find it from the running bridge: `ps aux | grep remote-control/bin`.
