# Pushing to GitHub

How this repository's code gets to `github.com/lertian/dsh-tui`.

## Branch policy

- **Single branch: `master`.** It is also the repository's default branch, so
  the GitHub page always shows the latest push.
- There is no `main`; the earlier duplicate was removed. Do not push `main`
  again (`git push origin master:main` recreates the confusion).

## Authentication: SSH

Pushing uses the dedicated SSH key `~/.ssh/dsh_github_ed25519` (public key is
registered on the GitHub account under "dsh-tui-push"). HTTPS token pushes are
NOT configured — the earlier fine-grained tokens only ever had read access and
were revoked.

```sh
# One-off push (any directory inside the checkout):
GIT_SSH_COMMAND='ssh -i ~/.ssh/dsh_github_ed25519 -o IdentitiesOnly=yes' \
  git push git@github.com:lertian/dsh-tui.git master
```

To avoid typing the command prefix every time, configure it once:

```sh
git config core.sshCommand 'ssh -i ~/.ssh/dsh_github_ed25519 -o IdentitiesOnly=yes'
git remote add origin git@github.com:lertian/dsh-tui.git   # if not already set
```

After that, a plain `git push` works.

## The standard flow

```sh
# 1. Verify nothing is broken (the pre-commit hooks also gate this):
pnpm run build
pnpm exec vitest run packages/tui
pnpm run lint

# 2. Stage and commit:
git add -A -- . ':!dist' ':!.tui-scratch'
git commit -m "feat(tui): ..."

# 3. Push:
git push
```

## Traps (all hit once, all now documented)

| Trap | Symptom | Fix |
|---|---|---|
| HTTPS token without `Contents: Read and write` | `403 Permission denied` | Use SSH instead; or grant the token Contents write in GitHub settings |
| Shallow clone | `remote unpack failed: index-pack failed` | `git fetch --unshallow origin` before pushing |
| Translation-pairing hook | Commit blocked, `🥊 translation pairing` | Run `pnpm run verify-translation-pairing --write <changed-README>` before committing |
| Staging build residue | `dist/` or `.tui-scratch/` enters the commit | Always stage with the `:!dist` `:!.tui-scratch` excludes |
| Editing paired READMEs | `out of sync` on the next commit | Re-record the pair with `verify-translation-pairing --write` |

## If the GitHub page looks stale

The default branch is `master`, so the page reflects `refs/heads/master`.
Check it directly:

```sh
GIT_SSH_COMMAND='ssh -i ~/.ssh/dsh_github_ed25519 -o IdentitiesOnly=yes' \
  git ls-remote git@github.com:lertian/dsh-tui.git
```

The README is served from the default branch; a push to `master` is visible
immediately (CDN may take a minute or two).
