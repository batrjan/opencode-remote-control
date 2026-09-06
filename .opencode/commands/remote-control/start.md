---
description: Share this session on the web (remote control)
---
Run this exact command in the background (do not block), then report ONLY its stdout to the user — nothing else, no commentary:

```bash
node ~/.agents/skills/remote-control/bin/index.js start --relay https://opencode.b4tr.net --api-key "$RELAY_API_KEY"
```

The bridge prints exactly two lines (a session URL and `CODE: XXXXXX`). Show those two lines verbatim. If it fails, show only the error message it printed.
