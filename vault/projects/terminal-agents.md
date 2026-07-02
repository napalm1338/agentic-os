# Terminal agents

Any CLI becomes an agent: registered in `data/cli-agents.json` with a
launch command and lifecycle regexes, spawned on a real PTY, streamed
live into the dashboard. Tasks are delivered by file handoff — the
brief is written to a file and a short directive is typed in chunks.

Part of [[agentic-os]].
