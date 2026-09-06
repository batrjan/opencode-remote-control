---
description: Show remote control session status
---
Run this command, then report ONLY its stdout to the user — nothing else:

```bash
node ~/.agents/skills/remote-control/bin/index.js status --relay https://opencode.b4tr.net
```

The session is identified automatically from the saved state. Report the output verbatim.