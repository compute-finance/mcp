## Pull request titles

For a PR targeting this repository's default branch, use Conventional Commits and
end the title with the Jira task key: `fix: correct fee calculation [CF-123]`.
The scope is optional; task prefixes are `CF`, `SCX` and `EF`. Ordinary agent PRs
also need a key. Automatic Dependabot updates and release-please release PRs are
the only exceptions. Fix a failing `governance/pr-title` check before merging.
Governance reference: DG-GH-32 "Jira task key in pull request titles".
