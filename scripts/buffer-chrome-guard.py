#!/usr/bin/env python3
"""PreToolUse hook for the Buffer comment jobs the video app starts (claude -p --chrome, see video-library/buffer-comments.js).

BUFFER_JOB=collect  reads comments: Chrome may open Buffer and run read-only queries, nothing else.
BUFFER_JOB=send     posts ONE reply the owner approved in the app: the only Buffer change allowed is
                    replyToComment on BUFFER_COMMENT_ID.
BUFFER_JOB=schedule fills Buffer's composer the owner asked for (Schedule on Buffer): clicking and typing are
                    allowed (on Buffer pages only), uploading only BUFFER_UPLOAD_FILE, and no script may change
                    anything in Buffer (no GraphQL mutations at all).
collect and send: no clicking, typing, form filling or uploads in any page. All jobs: navigation only to Buffer.
Anything else, unreadable input or an unknown job is blocked (exit 2).
"""
import json, os, re, sys

def block(msg):
    print(msg, file=sys.stderr)
    sys.exit(2)

try:
    event = json.load(sys.stdin)
except Exception:
    block("buffer-chrome-guard: unreadable tool call")
job = os.environ.get("BUFFER_JOB", "")
if job not in ("collect", "send", "schedule"):
    block("buffer-chrome-guard: unknown Buffer job")
name = str(event.get("tool_name", ""))
inp = json.dumps(event.get("tool_input", {}))
short = name.split("__")[-1]

if name == "ToolSearch":   # only loads the Chrome tools' definitions; it can't do anything by itself
    sys.exit(0)
if not name.startswith("mcp__claude-in-chrome__"):
    block(f"buffer-chrome-guard: {name} is not allowed in a Buffer {job} job")
# Page interaction that could change something by hand: only the schedule job fills the composer, and it may
# upload only the one prepared video.
if job == "schedule" and re.search(r"upload|file", short, re.I):
    path = os.environ.get("BUFFER_UPLOAD_FILE", "")
    if not path or path not in inp or re.search(r"\.\.", inp):
        block("buffer-chrome-guard: only the prepared video may be uploaded")
elif job == "schedule" and re.search(r"shortcut|gif", short, re.I):
    block(f"buffer-chrome-guard: {short} is not allowed")
elif job != "schedule" and re.search(r"computer|form_input|upload|file|shortcut|gif", short, re.I):
    block(f"buffer-chrome-guard: {short} is not allowed (no clicking, typing or uploading); use the JavaScript you were given")
if short == "navigate" or "url" in event.get("tool_input", {}):
    for u in re.findall(r"https?://[^\s\"']+", inp):
        host = re.sub(r"^https?://", "", u).split("/")[0].lower()
        if not (host == "buffer.com" or host.endswith(".buffer.com")):
            block(f"buffer-chrome-guard: only Buffer pages may be opened, not {host}")
if "javascript" in short:
    mutations = re.findall(r"\bmutation\b|replyToComment|deletePost|editPost|createPost|deleteComment|hideComment", inp)
    if job in ("collect", "schedule") and mutations:
        block("buffer-chrome-guard: the collector only reads; this script would change something in Buffer")
    if job == "send" and mutations:
        cid = os.environ.get("BUFFER_COMMENT_ID", "")
        others = [m for m in mutations if m not in ("mutation", "replyToComment")]
        if others or not cid or cid not in inp:
            block("buffer-chrome-guard: a send job may only run replyToComment on the approved comment")
sys.exit(0)
