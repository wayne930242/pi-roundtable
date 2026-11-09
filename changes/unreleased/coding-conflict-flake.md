---
type: Fixed
packages: [coding]
---
Two coding workers that start at once on one repository no longer fail now and then with `fatal: failed to read .git/worktrees/1/commondir`, which ended one of the tasks before its worker ran. Git lists every linked worktree while it adds, removes or prunes one and fails on a folder another such call is still writing, so the desk now makes, removes and prunes the worktrees of one clone one at a time.
