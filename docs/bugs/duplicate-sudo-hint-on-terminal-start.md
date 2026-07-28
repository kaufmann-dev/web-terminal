# Duplicate Sudo Hint on Terminal Start

- Fixed: 2026-07-28 10:43:22 CEST (+0200)
- Pre-fix commit: `e4ffde2e3f3811989ec75fa9deb8d18dcef2ce68`

## Symptom

Every newly created terminal printed Ubuntu's administrator hint twice before showing the prompt:

```text
To run a command as administrator (user "root"), use "sudo <command>".
See "man sudo_root" for details.
```

## Confirmed Root Cause

The Nixpacks Ubuntu base image assigns UID/GID 1000 to an `ubuntu` user with several supplementary
groups, including `sudo`. The rootless-Podman installer adopted that identity as `terminal` without
clearing those groups, so Ubuntu's system Bash configuration considered the terminal user an
administrator and printed its sudo hint.

Debian and Ubuntu Bash automatically load `/etc/bash.bashrc` for interactive shells. The managed
terminal rcfile loaded the same file again explicitly, causing the hint and all other system Bash
startup logic to run twice. Reproduction in the exact Nixpacks base image printed one hint with an
empty custom rcfile and two when that rcfile sourced `/etc/bash.bashrc`.

## Changes

- Clear every supplementary group after creating, adopting, or validating the terminal identity.
- Let Ubuntu Bash load `/etc/bash.bashrc` once automatically instead of sourcing it again from the
  managed terminal rcfile.
- Retain the persistent user `.bashrc` and add regression assertions for both corrections.
