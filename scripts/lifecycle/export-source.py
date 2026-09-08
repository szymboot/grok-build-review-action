"""Export tracked blobs without hooks, filters, Git metadata, or PR-controlled archive rules."""
import pathlib
import subprocess
import sys

root = pathlib.Path(sys.argv[1])
root.mkdir(parents=True, exist_ok=False)
entries = subprocess.check_output(["git", "ls-tree", "-rz", "--full-tree", "HEAD"]).split(b"\0")
total = 0
for entry in entries:
    if not entry:
        continue
    header, raw_path = entry.split(b"\t", 1)
    mode, kind, oid = header.split()
    if kind != b"blob" or mode not in (b"100644", b"100755"):
        raise RuntimeError("Symlinks and submodules require a separate verified snapshot; refusing incomplete analysis")
    name = raw_path.decode("utf-8")
    relative = pathlib.PurePosixPath(name)
    if relative.is_absolute() or any(part in ("..", ".git") for part in relative.parts):
        raise RuntimeError("Invalid tracked path")
    content = subprocess.check_output(["git", "cat-file", "blob", oid.decode("ascii")])
    total += len(content)
    if total > 100 * 1024 * 1024:
        raise RuntimeError("Source snapshot exceeds 100 MiB")
    target = root / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(content)
