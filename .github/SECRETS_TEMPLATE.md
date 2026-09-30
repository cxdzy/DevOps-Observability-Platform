# GitHub Actions Secrets — Required Setup

These secrets must be added under Repository Settings > Secrets and variables >
Actions before the CI/CD workflow (.github/workflows/ci-cd.yml) can deploy to
the VPS. This file documents what is needed; it does not contain real values.

| Secret name    | Description                                              | How to generate                                                     |
|-----------------|-----------------------------------------------------------|-----------------------------------------------------------------------|
| VPS_HOST        | Public IP address of the deployment VPS                   | From your VPS provider dashboard                                    |
| VPS_USER        | SSH username used to deploy                                | Typically `root`                                                    |
| VPS_SSH_KEY     | Private SSH key GitHub Actions uses to reach the VPS       | `ssh-keygen -t ed25519 -f ~/.ssh/gh_actions_deploy -N ""` on the VPS, then append the `.pub` file to `~/.ssh/authorized_keys` and paste the private key here |
| GHCR_TOKEN      | Read-only token so the VPS can pull images from GHCR       | GitHub > Settings > Developer settings > Personal access tokens > Fine-grained > scope: this repo only, Packages: Read-only |
| TAILSCALE_OAUTH_CLIENT_ID | OAuth client ID so GitHub Actions can join the tailnet temporarily | Tailscale admin console > Settings > OAuth clients > Generate, scope: Devices Core Write, tag: tag:ci |
| TAILSCALE_OAUTH_SECRET | OAuth client secret, paired with the ID above | Same screen, shown once |

## Notes

- `GITHUB_TOKEN` (used to push images to GHCR during the build step) is
  provided automatically by GitHub Actions and does not need to be added
  manually.
- `VPS_SSH_KEY` must be the private key, not the public key. Paste the full
  contents including the `-----BEGIN...-----` and `-----END...-----` lines.
- `GHCR_TOKEN` only needs Packages: Read-only, since the VPS only pulls
  images. It never pushes.
- Rotate `GHCR_TOKEN` if it is ever exposed in logs or committed by mistake.
- None of these values should ever be committed to this repository. This
  file exists only to document what each secret is for.
