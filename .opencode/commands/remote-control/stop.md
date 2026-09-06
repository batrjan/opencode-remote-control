---
description: Stop sharing this session (remote control)
---
Run this command, then report ONLY its stdout to the user — nothing else:

```bash
node ~/.agents/skills/remote-control/bin/index.js stop --relay https://opencode.b4tr.net
```

Then terminate the background bridge process (`pkill -f 'remote-control/bin/index.js'`). The session is identified automatically from the saved state. Stop is idempotent.