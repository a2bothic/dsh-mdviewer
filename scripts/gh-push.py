#!/usr/bin/env python3
"""Push a local git repository to GitHub using the `gh` CLI's API access.

Raw git-over-HTTPS does not work from this WSL environment, but `gh api` does,
so this recreates the local commit history on the remote through the Git Data
API instead:

  blob   -> one per file
  tree   -> the working tree of each commit
  commit -> replaying each local commit's message and parent chain
  ref    -> moving refs/heads/main to the new head

Only the tip tree is uploaded for files (blobs are deduplicated by content),
and the commit history is replayed so the remote matches `git log`.
"""
import json
import subprocess
import sys
from pathlib import Path

GH = "/mnt/c/Program Files/GitHub CLI/gh.exe"
OWNER = "a2bothic"
REPO = "dsh-mdviewer"
BRANCH = "main"


def gh(*args, stdin=None):
    """Run a gh command; return parsed JSON when the output is JSON."""
    cmd = [GH, *args]
    proc = subprocess.run(cmd, capture_output=True, text=True, input=stdin)
    if proc.returncode != 0:
        raise RuntimeError(f"gh failed: {' '.join(args)}\n{proc.stderr.strip()}")
    out = proc.stdout.strip()
    if not out:
        return None
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        return out


def git(*args, cwd):
    proc = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {proc.stderr.strip()}")
    return proc.stdout


def main():
    root = Path(__file__).resolve().parent.parent
    print(f"repo: {root}")

    # Collect the local history oldest-first so parents exist before children.
    log = git("log", "--reverse", "--format=%H%x00%an%x00%ae%x00%P%x00%B%x01",
              cwd=root)
    commits = []
    for record in log.split("\x01"):
        record = record.strip("\n")
        if not record.strip():
            continue
        sha, an, ae, parents, message = record.split("\x00", 4)
        commits.append({
            "sha": sha.strip(), "author": an, "email": ae,
            "parents": parents.split() if parents.strip() else [],
            "message": message.rstrip("\n"),
        })
    print(f"local commits: {len(commits)}")

    remote_shas = {}   # local sha -> remote sha
    head = None

    for c in commits:
        # Upload every file in this commit as a blob (dedup by content hash).
        files = git("ls-tree", "-r", "-z", "--name-only", c["sha"], cwd=root)
        paths = [p for p in files.split("\0") if p]
        tree_entries = []
        for path in paths:
            blob = subprocess.run(
                ["git", "cat-file", "blob", f"{c['sha']}:{path}"],
                cwd=root, capture_output=True)
            if blob.returncode != 0:
                print(f"  skip unreadable: {path}")
                continue
            res = gh("api", f"repos/{OWNER}/{REPO}/git/blobs",
                     "-X", "POST", "--input", "-",
                     stdin=json.dumps({
                         "content": blob.stdout.decode("utf-8", "replace"),
                         "encoding": "utf-8",
                     }))
            tree_entries.append({
                "path": path, "mode": "100644", "type": "blob",
                "sha": res["sha"],
            })

        tree = gh("api", f"repos/{OWNER}/{REPO}/git/trees",
                  "-X", "POST", "--input", "-",
                  stdin=json.dumps({"tree": tree_entries}))

        payload = {"message": c["message"], "tree": tree["sha"]}
        if c["parents"]:
            payload["parents"] = [remote_shas[p] for p in c["parents"] if p in remote_shas]

        new = gh("api", f"repos/{OWNER}/{REPO}/git/commits",
                 "-X", "POST", "--input", "-", stdin=json.dumps(payload))
        remote_shas[c["sha"]] = new["sha"]
        head = new["sha"]
        print(f"  {c['sha'][:7]} -> {new['sha'][:7]}  {c['message'].splitlines()[0][:60]}")

    # Point the branch at the new head (create it if this is the first push).
    try:
        gh("api", f"repos/{OWNER}/{REPO}/git/refs/heads/{BRANCH}",
           "-X", "PATCH", "--input", "-",
           stdin=json.dumps({"sha": head, "force": True}))
    except RuntimeError:
        gh("api", f"repos/{OWNER}/{REPO}/git/refs",
           "-X", "POST", "--input", "-",
           stdin=json.dumps({"ref": f"refs/heads/{BRANCH}", "sha": head}))

    # Make main the default branch.
    gh("api", f"repos/{OWNER}/{REPO}", "-X", "PATCH", "--input", "-",
       stdin=json.dumps({"default_branch": BRANCH}))

    print(f"\npushed {len(commits)} commits -> https://github.com/{OWNER}/{REPO}")


if __name__ == "__main__":
    sys.exit(main())
