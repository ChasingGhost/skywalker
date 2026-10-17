#!/usr/bin/env python3
"""Build one stream-copied "preview reel" per date folder.

For every subfolder of ROOT (each assumed to hold one day's clips):
  * finds the video files (by extension, confirmed with ffprobe),
  * sorts them by recording timestamp from metadata
    (format/stream `creation_time`, Apple QuickTime creationdate, etc.),
    falling back to the file's filesystem birth/modify time only if no
    metadata timestamp exists,
  * concatenates them with ffmpeg's concat demuxer using `-c copy`
    (no re-encode, no transitions, no edits),
  * writes  "<ROOT>/Preview Clips/<FolderName>_preview.mp4".

Single-clip folders are stream-copied too, so every folder gets an output.

Usage:
    python3 make_preview_reels.py /path/to/footage-root [--output "/path/to/Preview Clips"]

Requires ffmpeg and ffprobe on PATH.
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timezone

VIDEO_EXTS = {
    ".mp4", ".mov", ".m4v", ".mts", ".m2ts", ".avi", ".mkv", ".3gp", ".mpg", ".mpeg", ".wmv", ".webm",
}
OUTPUT_DIR_NAME = "Preview Clips"


def ffprobe(path):
    """Return parsed ffprobe JSON, or None if the file isn't a readable video."""
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", path],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        return None
    info = json.loads(result.stdout or "{}")
    if not any(s.get("codec_type") == "video" for s in info.get("streams", [])):
        return None
    return info


def parse_ts(value):
    if not value:
        return None
    value = value.strip().replace("Z", "+00:00")
    for fmt in (None, "%Y-%m-%d %H:%M:%S", "%Y:%m:%d %H:%M:%S"):
        try:
            dt = datetime.fromisoformat(value) if fmt is None else datetime.strptime(value, fmt)
        except ValueError:
            continue
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        # Ignore the 1904/1970 "zero" dates some cameras write when the clock is unset.
        if dt.year < 1990:
            return None
        return dt
    return None


def recording_time(path, info):
    """Recording timestamp from metadata; filesystem time only as a last resort."""
    tag_sets = [info.get("format", {}).get("tags", {})]
    tag_sets += [s.get("tags", {}) for s in info.get("streams", [])]
    keys = ("com.apple.quicktime.creationdate", "creation_time", "date", "DateTimeOriginal")
    for key in keys:
        for tags in tag_sets:
            lowered = {k.lower(): v for k, v in tags.items()}
            dt = parse_ts(lowered.get(key.lower()))
            if dt:
                return dt, "metadata"
    st = os.stat(path)
    ts = getattr(st, "st_birthtime", None) or st.st_mtime
    return datetime.fromtimestamp(ts, tz=timezone.utc), "file time"


def duration(info):
    try:
        return float(info["format"]["duration"])
    except (KeyError, TypeError, ValueError):
        return 0.0


def fmt_runtime(seconds):
    seconds = int(round(seconds))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def concat(clips, out_path):
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, encoding="utf-8") as f:
        for clip in clips:
            escaped = os.path.abspath(clip).replace("'", r"'\''")
            f.write(f"file '{escaped}'\n")
        list_path = f.name
    try:
        cmd = [
            "ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", list_path,
            "-map", "0:v", "-map", "0:a?", "-c", "copy", "-movflags", "+faststart", out_path,
        ]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            raise RuntimeError(result.stderr.strip())
    finally:
        os.unlink(list_path)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("root", help="Folder containing the date folders")
    parser.add_argument("--output", help=f'Master output folder (default: <root>/"{OUTPUT_DIR_NAME}")')
    args = parser.parse_args()

    root = os.path.abspath(args.root)
    out_dir = os.path.abspath(args.output or os.path.join(root, OUTPUT_DIR_NAME))
    os.makedirs(out_dir, exist_ok=True)

    summary = []
    for name in sorted(os.listdir(root)):
        folder = os.path.join(root, name)
        if not os.path.isdir(folder) or os.path.abspath(folder) == out_dir or name.startswith("."):
            continue

        clips = []
        for fname in os.listdir(folder):
            path = os.path.join(folder, fname)
            if not os.path.isfile(path) or os.path.splitext(fname)[1].lower() not in VIDEO_EXTS:
                continue
            info = ffprobe(path)
            if info is None:
                print(f"  skip (not a readable video): {path}", file=sys.stderr)
                continue
            ts, source = recording_time(path, info)
            clips.append((ts, fname, path, duration(info), source))

        if not clips:
            print(f"- {name}: no video clips, skipped")
            continue

        clips.sort(key=lambda c: (c[0], c[1]))
        out_path = os.path.join(out_dir, f"{name}_preview.mp4")
        print(f"- {name}: {len(clips)} clip(s) -> {out_path}")
        for ts, fname, _, dur, source in clips:
            print(f"    {ts.isoformat()}  ({source})  {fmt_runtime(dur):>8}  {fname}")
        try:
            concat([c[2] for c in clips], out_path)
        except RuntimeError as err:
            print(f"  FAILED: {err}\n  (clips with different codecs/resolutions can't be joined without re-encoding)")
            summary.append((name, len(clips), None))
            continue
        out_info = ffprobe(out_path)
        summary.append((name, len(clips), duration(out_info) if out_info else None))

    print("\nSummary")
    print(f"{'Folder':<30} {'Clips':>5}  Runtime")
    for name, count, runtime in summary:
        print(f"{name:<30} {count:>5}  {fmt_runtime(runtime) if runtime is not None else 'FAILED'}")


if __name__ == "__main__":
    main()
