---
description: Stop remote control for this session
---
Stop remote control: run `node bridge/dist/index.js stop --relay https://opencode.b4tr.net --api-key $RELAY_API_KEY --session-id <session_id>`. The session_id was shown when start was run; if unknown, run `node bridge/dist/index.js status --relay https://opencode.b4tr.net --api-key $RELAY_API_KEY --session-id <id>` to check. Stop is idempotent.
