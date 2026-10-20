#!/usr/bin/env python3
"""Merge every video in a folder into one MP4 per recording date.

    python compile_by_date.py                      # uses E:\\DJI\\Recent vids
    python compile_by_date.py "D:\\Some\\Folder"   # any other folder
    python compile_by_date.py SRC --output DEST    # choose where outputs go

What it does, with no prompts:
  * Reads each clip's recording date/time from the filename
    (DJI_20261019143015_0001_D.MP4, 20261019_143015.mp4, ...) or, failing
    that, from the file's metadata (creation_time).
  * Groups clips by date and sorts each group chronologically.
  * Joins each group with ffmpeg stream copy (no re-encode, no quality loss).
    Only if a day's clips have mismatched formats (e.g. 4K drone + 1080p phone)
    is that day re-encoded at high quality, and the report says so.
  * Writes YYYY-MM-DD_Compiled.mp4 per date into DEST
    (default: "<SRC>\\Compiled"), plus report.csv and errors.log.
  * Skips corrupted/unreadable files and logs why.
  * Never modifies, moves or deletes the source clips: they are only read.

Requires Python 3.8+ and ffmpeg/ffprobe on PATH.
"""

import argparse
import csv
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
from collections import defaultdict
from datetime import datetime, timezone

DEFAULT_SOURCE = r"E:\DJI\Recent vids"
OUTPUT_DIR_NAME = "Compiled"
# .LRF (DJI low-res proxies) are deliberately excluded: they duplicate the .MP4 footage.
VIDEO_EXTS = {".mp4", ".mov", ".m4v", ".mts", ".m2ts", ".avi", ".mkv", ".3gp", ".mpg", ".mpeg", ".webm"}

# YYYYMMDD then optional separator and HHMMSS, e.g. DJI_20261019143015_..., 20261019_143015, VID_20261019_143015
FILENAME_TS = re.compile(r"(?<!\d)(20\d{2})(\d{2})(\d{2})[_\-\s]?(\d{2})(\d{2})(\d{2})(?!\d)")
FILENAME_DATE = re.compile(r"(?<!\d)(20\d{2})[-_]?(\d{2})[-_]?(\d{2})(?!\d)")

log = logging.getLogger("compile")


def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")


def probe(path):
    """ffprobe JSON for a playable video, or raise ValueError describing the problem."""
    res = run(["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", path])
    if res.returncode != 0:
        raise ValueError(res.stderr.strip().splitlines()[-1] if res.stderr.strip() else "ffprobe failed")
    info = json.loads(res.stdout or "{}")
    if not any(s.get("codec_type") == "video" for s in info.get("streams", [])):
        raise ValueError("no video stream")
    if duration_of(info) <= 0:
        raise ValueError("zero or unknown duration (file may be truncated)")
    return info


def duration_of(info):
    try:
        return float(info["format"]["duration"])
    except (KeyError, TypeError, ValueError):
        return 0.0


def timestamp_from_filename(name):
    m = FILENAME_TS.search(name)
    if m:
        try:
            return datetime(*map(int, m.groups()))
        except ValueError:
            pass
    m = FILENAME_DATE.search(name)
    if m:
        try:
            return datetime(*map(int, m.groups()))
        except ValueError:
            pass
    return None


def timestamp_from_metadata(info):
    tag_sets = [info.get("format", {}).get("tags", {})] + [s.get("tags", {}) for s in info.get("streams", [])]
    for key in ("com.apple.quicktime.creationdate", "creation_time"):
        for tags in tag_sets:
            value = {k.lower(): v for k, v in tags.items()}.get(key)
            if not value:
                continue
            try:
                dt = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
            except ValueError:
                continue
            if dt.year < 2000:  # camera clock never set
                continue
            if dt.tzinfo is not None:
                dt = dt.astimezone().replace(tzinfo=None)  # to this PC's local time
            return dt
    return None


def stream_signature(info):
    """Properties that must match for a lossless (stream copy) join."""
    v = next(s for s in info["streams"] if s.get("codec_type") == "video")
    a = next((s for s in info["streams"] if s.get("codec_type") == "audio"), None)
    return (
        v.get("codec_name"), v.get("width"), v.get("height"), v.get("pix_fmt"), v.get("r_frame_rate"),
        a.get("codec_name") if a else None, a.get("sample_rate") if a else None, a.get("channels") if a else None,
    )


def write_concat_list(paths, list_path):
    with open(list_path, "w", encoding="utf-8") as f:
        for p in paths:
            f.write("file '" + os.path.abspath(p).replace("\\", "/").replace("'", r"'\''") + "'\n")


def concat_copy(paths, out_path, work_dir):
    list_path = os.path.join(work_dir, "list.txt")
    write_concat_list(paths, list_path)
    res = run(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", list_path,
               "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", "-movflags", "+faststart", out_path])
    if res.returncode != 0:
        raise RuntimeError(res.stderr.strip() or "ffmpeg concat failed")


def concat_reencode(clips, out_path, work_dir):
    """Normalise every clip to the first clip's resolution/frame rate, then join losslessly."""
    v0 = next(s for s in clips[0]["info"]["streams"] if s.get("codec_type") == "video")
    w, h, fps = v0["width"], v0["height"], v0.get("r_frame_rate", "30/1")
    parts = []
    for i, clip in enumerate(clips):
        part = os.path.join(work_dir, f"part_{i:04d}.mp4")
        has_audio = any(s.get("codec_type") == "audio" for s in clip["info"]["streams"])
        cmd = ["ffmpeg", "-y", "-v", "error", "-i", clip["path"]]
        if not has_audio:
            cmd += ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"]
        cmd += ["-map", "0:v:0", "-map", "0:a:0" if has_audio else "1:a:0",
                "-vf", f"scale={w}:{h}:force_original_aspect_ratio=decrease,"
                       f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={fps}",
                "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", "-shortest", part]
        res = run(cmd)
        if res.returncode != 0:
            raise RuntimeError(f"re-encode of {clip['name']} failed: {res.stderr.strip()}")
        parts.append(part)
    concat_copy(parts, out_path, work_dir)


def fmt_duration(seconds):
    seconds = int(round(seconds))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h:02d}:{m:02d}:{s:02d}"


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("source", nargs="?", default=DEFAULT_SOURCE, help=f"Folder of clips (default: {DEFAULT_SOURCE})")
    parser.add_argument("--output", help=f'Output folder (default: <source>\\{OUTPUT_DIR_NAME})')
    parser.add_argument("--recursive", action="store_true", help="Also scan subfolders")
    args = parser.parse_args()

    source = os.path.abspath(args.source)
    out_dir = os.path.abspath(args.output or os.path.join(source, OUTPUT_DIR_NAME))
    if not os.path.isdir(source):
        sys.exit(f"Source folder not found: {source}")
    for tool in ("ffmpeg", "ffprobe"):
        if not shutil.which(tool):
            sys.exit(f"{tool} not found on PATH. Install it (e.g. 'winget install ffmpeg') and reopen the terminal.")
    os.makedirs(out_dir, exist_ok=True)

    logging.basicConfig(level=logging.INFO, format="%(message)s", handlers=[logging.StreamHandler(sys.stdout)])
    err_handler = logging.FileHandler(os.path.join(out_dir, "errors.log"), mode="w", encoding="utf-8")
    err_handler.setLevel(logging.WARNING)
    err_handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    log.addHandler(err_handler)

    # 1. Scan
    candidates = []
    for dirpath, dirnames, filenames in os.walk(source):
        dirnames[:] = [d for d in dirnames if os.path.abspath(os.path.join(dirpath, d)) != out_dir]
        candidates += [os.path.join(dirpath, f) for f in filenames if os.path.splitext(f)[1].lower() in VIDEO_EXTS]
        if not args.recursive:
            break
    log.info(f"Found {len(candidates)} video file(s) in {source}")

    # 2. Probe, date and group
    groups = defaultdict(list)
    for path in sorted(candidates):
        name = os.path.basename(path)
        try:
            info = probe(path)
        except ValueError as err:
            log.warning(f"SKIPPED corrupted/unreadable file: {path} ({err})")
            continue
        ts, source_of_ts = timestamp_from_filename(name), "filename"
        if ts is None:
            ts, source_of_ts = timestamp_from_metadata(info), "metadata"
        if ts is None:
            ts = datetime.fromtimestamp(os.path.getmtime(path))
            source_of_ts = "file modified time"
            log.warning(f"No date in filename or metadata, using file modified time: {path}")
        groups[ts.date()].append({"path": path, "name": name, "ts": ts, "src": source_of_ts,
                                  "info": info, "duration": duration_of(info)})

    # 3. Merge each date
    report = []
    for day in sorted(groups):
        clips = sorted(groups[day], key=lambda c: (c["ts"], c["name"]))
        out_name = f"{day.isoformat()}_Compiled.mp4"
        out_path = os.path.join(out_dir, out_name)
        log.info(f"\n{day.isoformat()}: {len(clips)} clip(s) -> {out_name}")
        for c in clips:
            log.info(f"   {c['ts']:%H:%M:%S} ({c['src']})  {fmt_duration(c['duration'])}  {c['name']}")

        lossless = len({stream_signature(c["info"]) for c in clips}) == 1
        method = "stream copy" if lossless else "re-encoded (clips had different formats)"
        if not lossless:
            log.warning(f"{day}: clips have different resolution/codec/frame rate; re-encoding this date")

        work_dir = tempfile.mkdtemp(prefix=".compile_", dir=out_dir)
        tmp_out = os.path.join(work_dir, out_name)
        try:
            if lossless:
                try:
                    concat_copy([c["path"] for c in clips], tmp_out, work_dir)
                except RuntimeError as err:
                    log.warning(f"{day}: stream copy failed ({err}); falling back to re-encode")
                    method = "re-encoded (stream copy failed)"
                    concat_reencode(clips, tmp_out, work_dir)
            else:
                concat_reencode(clips, tmp_out, work_dir)
            os.replace(tmp_out, out_path)
            total = duration_of(probe(out_path))
            status = "OK"
            log.info(f"   done: {fmt_duration(total)} via {method}")
        except (RuntimeError, ValueError) as err:
            log.error(f"{day}: FAILED to create {out_name}: {err}")
            total, status, out_name = sum(c["duration"] for c in clips), "FAILED", ""
        finally:
            shutil.rmtree(work_dir, ignore_errors=True)
        report.append({"Date": day.isoformat(), "Clip count": len(clips), "Output filename": out_name,
                       "Total duration": fmt_duration(total), "Method": method, "Status": status})

    # 4. Report
    report_path = os.path.join(out_dir, "report.csv")
    with open(report_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=["Date", "Clip count", "Output filename", "Total duration", "Method", "Status"])
        writer.writeheader()
        writer.writerows(report)

    log.info(f"\n{'Date':<12} {'Clips':>5}  {'Duration':>8}  Output")
    for r in report:
        log.info(f"{r['Date']:<12} {r['Clip count']:>5}  {r['Total duration']:>8}  {r['Output filename'] or 'FAILED'}")
    log.info(f"\nReport: {report_path}\nErrors: {os.path.join(out_dir, 'errors.log')}")


if __name__ == "__main__":
    main()
