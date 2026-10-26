#!/bin/zsh
# Append one paid job to the shared credit ledger, spend.csv at the hub root (one row per submitted job).
#   scripts/spend.sh <project> <skill> <job id> <model> <credits> [note]
# Run it right after submitting a paid job, in every pipeline. The Studio totals it per project and per day.
set -e
[[ $# -ge 5 ]] || { echo "usage: $0 <project> <skill> <job id> <model> <credits> [note]" >&2; exit 2; }
[[ "$5" =~ '^[0-9]+(\.[0-9]+)?$' ]] || { echo "credits must be a number: $5" >&2; exit 2; }
csv="${0:A:h:h}/spend.csv"
python3 -I - "$csv" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" "$3" "$4" "$5" "${STUDIO_RUN_ID:-}" "${6:-}" <<'EOF'
import csv, sys
import fcntl
path, *row = sys.argv[1:]
# One lock for header + row, so two first jobs at the same moment can't truncate each other's rows.
with open(path, "a", newline="") as f:
    fcntl.flock(f, fcntl.LOCK_EX)
    f.seek(0, 2)   # the size now, after the lock (another writer may have added the header meanwhile)
    if f.tell() == 0:
        csv.writer(f).writerow(["when", "project", "skill", "job_id", "model", "credits", "run", "note"])
    csv.writer(f).writerow(row)
EOF
echo "spend: $5 cr · $1 · $3"
