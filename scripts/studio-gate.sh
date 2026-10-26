#!/bin/zsh
# Tell the Video Studio (localhost:4420/studio) that a session is waiting for the owner, or that it was answered.
#   scripts/studio-gate.sh open  <id> <pipeline> <project> <title> [credits] [detail] [image …] [--option "<spec>" …]
#   scripts/studio-gate.sh clear <id>
#   scripts/studio-gate.sh wait  <id>     (a chat session, in the background: ends with the owner's Studio answer)
#   scripts/studio-gate.sh step  <project> <pipeline> <step> [note] [file …]   (the step shown on the run's page in the Studio;
#        the files are what that step made: the owner sees them when they open the step)
# Steps: character swap skills use their state.json stages (mapped planned built test-approved test-run reviewed
# rest-approved run assembled filed approved hd); /video projects report theirs through shots.json, so they only
# need `step` once, to link the session to its project.
# <id> is stable per gate (e.g. "cat-dj:concepts-v2") so re-opening updates it instead of duplicating.
# credits: the price to approve ("" when free). image: paths (absolute, or relative to the repo folder) of
# boards/frames the owner should look at, or videos (.mp4/.mov/.m4v/.webm: a test result, a final), which play
# in the Studio. The Studio only reads runs/ and projects/, so a chat session's file from anywhere else (its
# scratchpad, a subject folder…) is cloned into runs/gate-media/<id>/ first; clear removes that copy.
# --option (repeat it, one per choice) makes the question a single pick: the owner clicks a card and Approve.
#   spec = "<id>[*]|<label>|<why>|<image>|<credits>"; only id and label are needed; * marks the one you recommend
#   (at most one). An option's credits are what Approve on that option pays for (else the question's credits).
#   e.g. --option "A|Pet-sized|sits on the chair like a real cat|still-A.png|12" --option "B*|His size|matches the source framing|still-B.png|12"
#   The answer names the option ("They picked option B"); notes are for "none of these" or a mix.
# A background run started by the Studio has STUDIO_RUN_ID set; the gate is linked to it, so the owner's
# Approve / Notes in the Studio resumes this run.
# Never fails the caller: if the Studio is down, it says so and exits 0. In a chat session the approval still happens in chat.
root="${0:A:h:h}"
# A background run uses its own run token (it can only post and clear its own gates); chat sessions use the owner's.
if [[ -n "${STUDIO_RUN_TOKEN:-}" ]]; then auth="X-Studio-Run-Token: $STUDIO_RUN_TOKEN"
else
  token=$(cat "$root/video-library/.studio-token" 2>/dev/null) || { echo "studio-gate: no Studio token (is the Studio running?)"; exit 0; }
  auth="X-Studio-Token: $token"
fi
url=http://127.0.0.1:${STUDIO_PORT:-4420}/api/studio
case "$1" in
  wait)
    # A chat session runs this as a background command right after `open`. It ends as soon as the owner answers
    # the gate in the Studio app (Approve or notes), and its output, the answer, wakes the session up. If the
    # owner answers in the chat instead, the session clears the gate and this ends with nothing to do.
    [[ $# -eq 2 ]] || { echo "usage: $0 wait <id>" >&2; exit 2; }
    exec python3 -I - "$url" "$2" <<'EOF'
import json, sys, time, urllib.error, urllib.parse, urllib.request
url, gid = sys.argv[1:]
missing = 0
for _ in range(12 * 3600 // 3):          # gives up after 12 hours
    try:
        with urllib.request.urlopen(f"{url}/gate?id={urllib.parse.quote(gid)}", timeout=5) as r: g = json.load(r)
        missing = 0
    except urllib.error.HTTPError as e:
        g = None
        if e.code == 404:
            missing += 1
            if missing > 3: print(f"studio-gate: gate {gid} is not in the Studio; nothing to wait for."); sys.exit(0)
    except Exception:
        g = None                          # the Studio is restarting: keep waiting
    if g and g.get("answer") == "approved":
        cr = f" ({g['credits']} credits)" if g.get("credits") else ""
        note = f" Their note: {g['note']}" if g.get("note") else ""
        pick = f' They picked option {g["choice"]} ("{g.get("choiceLabel") or g["choice"]}"); go ahead with that option only.' if g.get("choice") else ""
        print(f'The owner APPROVED in the Studio: "{g["title"]}"{cr}.{pick}{note} This is their yes for exactly what the gate listed; continue the skill from this gate.')
        sys.exit(0)
    if g and g.get("answer") == "notes":
        print(f'The owner did NOT approve "{g["title"]}" yet. Their notes from the Studio: {g["note"]} Revise as the skill says, then post a new gate. Spend nothing.')
        sys.exit(0)
    if g and g.get("cleared"):
        print(f"studio-gate: gate {gid} was cleared (answered in the chat or withdrawn); nothing to do."); sys.exit(0)
    time.sleep(3)
print(f"studio-gate: stopped waiting for {gid} after 12 hours; ask the owner in the chat.")
EOF
    ;;
  open|step)
    if [[ $1 == open ]]; then [[ $# -ge 5 ]] || { echo "usage: $0 open <id> <pipeline> <project> <title> [credits] [detail] [image …]" >&2; exit 2; }
    else [[ $# -ge 4 ]] || { echo "usage: $0 step <project> <pipeline> <step> [note] [file …]" >&2; exit 2; }; fi
    body=$(python3 -I - "$root" "${STUDIO_RUN_ID:-}" "$@" <<'EOF'
import json, os, re, shutil, subprocess, sys, time
root, run, mode, *args = sys.argv[1:]
def media(paths, folder):
    files = [os.path.abspath(os.path.join(root, p)) for p in paths]
    if run: return files   # a background run's files are already in runs/<id>/work
    inside = lambda f: any(os.path.realpath(f).startswith(os.path.join(root, d) + os.sep) for d in ("runs", "projects"))
    dest = os.path.join(root, "runs", folder)
    for i, f in enumerate(files):
        # Only pictures and videos: anything else (the Studio token…) must never land where runs can read it.
        if inside(f) or not os.path.isfile(f) or not re.search(r"\.(png|jpe?g|gif|webp|mp4|mov|m4v|webm)$", f, re.I): continue
        os.makedirs(dest, exist_ok=True)
        dst = os.path.join(dest, f"{i:02d}-" + os.path.basename(f))
        # cp -c clones on APFS (no extra disk for a big final); plain copy elsewhere.
        if subprocess.run(["cp", "-c", f, dst], capture_output=True).returncode: shutil.copyfile(f, dst)
        files[i] = dst
    return files
safe = lambda x: re.sub(r"[^A-Za-z0-9_-]", "_", x)
if mode == "open":
    gid, pipeline, project, title, *rest = args
    files, specs, i = [], [], 2
    while i < len(rest):   # pictures and videos, with --option "<spec>" anywhere among them
        if rest[i] == "--option" and i + 1 < len(rest): specs.append(rest[i + 1]); i += 2
        else: files.append(rest[i]); i += 1
    options = []
    for spec in specs:
        f = (spec.split("|") + [""] * 5)[:5]
        oid = f[0].strip()
        options.append({"id": oid.rstrip("*").strip(), "recommended": oid.endswith("*"), "label": f[1].strip(), "why": f[2].strip(),
                        "image": f[3].strip() or None, "credits": f[4].strip() or None})
    pics = [o["image"] for o in options if o["image"]]
    copied = media(files + pics, "gate-media/" + safe(gid))
    for o in options:
        if o["image"]: o["image"] = copied[len(files) + pics.index(o["image"])]
    print(json.dumps({"id": gid, "pipeline": pipeline, "project": project, "title": title, "credits": rest[0] if rest and rest[0] else None,
                      "detail": rest[1] if len(rest) > 1 else "", "images": copied[:len(files)], "options": options, "runId": run or None}))
else:   # step: the files it made are shown when the owner opens that step in the Studio
    project, pipeline, step, *rest = args
    print(json.dumps({"project": project, "pipeline": pipeline, "step": step, "note": rest[0] if rest else "",
                      "files": media(rest[1:], f"step-media/{safe(project)}/{safe(step)}-{int(time.time())}")}))
EOF
)
    [[ $1 == open ]] && endpoint=gate || endpoint=step ;;
  clear)
    [[ $# -eq 2 ]] || { echo "usage: $0 clear <id>" >&2; exit 2; }
    body=$(python3 -I -c 'import json,sys; print(json.dumps({"id":sys.argv[1]}))' "$2")
    [[ -n "${2//[^A-Za-z0-9_-]/}" ]] && rm -rf "$root/runs/gate-media/${2//[^A-Za-z0-9_-]/_}"
    endpoint=gate/clear ;;
  *) echo "usage: $0 open|clear|wait|step …" >&2; exit 2 ;;
esac
code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' -X POST -H "$auth" -H 'Content-Type: application/json' "$url/$endpoint" -d "$body")
case "$code" in
  200) echo "studio-gate: $1 ${2}" ;;
  000) echo "studio-gate: Studio not reachable (gate not shown there)" ;;
  *)   echo "studio-gate: the Studio refused it (HTTP $code); the gate is NOT shown there" ;;
esac
exit 0
