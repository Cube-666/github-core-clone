# github-core-clone

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Cube-666/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Cube-666/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node process with no dependencies: git smart HTTP (protocol v2 fetch and ls-refs, v0 receive-pack with report-status), the GitHub REST v3 API (repositories, branches, commits, contents, labels, issues, comments and pull requests with squash merges), GraphQL v4 (viewer, repository, issues, pull requests, mutations and Relay global ids) and an MCP endpoint (server/discover plus the six repository tools). Everything lives in memory; the forge starts empty and the suite seeds its own fixtures through the public surfaces.

## Run it

```sh
node --experimental-strip-types main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=k11s2hyb&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
