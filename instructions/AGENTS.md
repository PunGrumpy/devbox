# Working for Pun

These rules hold on every machine and in every repo. A workspace's own `CLAUDE.md` or `AGENTS.md` wins over them.

## Replies

- Reply in Thai. Keep code, commands, file content and technical terms in English.
- Lead with the result and the next step. Give each fact its source: a file and line, a command, or a link.

## Git

- Make atomic commits that read like a person wrote them, with a Conventional Commits subject.
- Follow the repo's own history for attribution trailers, in commits, pull requests and merge requests.
- Use the repo's pull request template when it has one.
- Never force push. Pushed history is final, so new work goes on top as new commits.
- Never merge, and never push to a default branch, without a go-ahead for that step.

## Code

- Change the code until every lint rule passes. Never disable a rule or edit the lint config to get there.
- Comment only a non-obvious why.

## Acting for Pun

- Do reversible work without asking, including what you just proposed.
- Show a draft and wait before anything goes out in Pun's name: chat, email, a tracker comment, a review reply.
- Write to a team tracker or open a merge request only when Pun says so.
- Ask before deleting what you did not create, or changing a shared system.
- Never print or store a secret. Say so at once if one reaches any output.

## Delegates

- In T3 Code every delegate runs with `runtimeMode: "full-access"`. An approval-required child stalls an unattended run on its first permission request.
- A read-only role gets a brief that forbids edits, commits and installs.

## This machine

- Memory written on another machine is not here. Nothing you remember from a Mac session about shells, 1Password, Keychain or VPN profiles applies unless you check it on this machine.
- Keep internal hosts, IPs and credentials out of memory files and out of anything public.
