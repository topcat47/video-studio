#!/usr/bin/env python3
"""PUT a batch of Higgsfield uploads straight from a saved media_upload response.

A media_upload call for ~15+ files returns more text than the tool output holds, so it is saved to a
tool-results file; this reads that JSON and PUTs every file it names, no URL copying.
Usage: python3 -I scripts/swap/put_uploads.py <saved response.json> <dir with the files> <ids.tsv>
Appends name<TAB>media_id<TAB>http code to ids.tsv; then media_confirm the ids (20 per call).
"""
import json, re, subprocess, sys
resp, d, out = sys.argv[1], sys.argv[2], sys.argv[3]
ups = json.load(open(resp))['uploads']
rows = []
for u in ups:
    name = re.search(r'--data-binary @(\S+)', u['instructions']).group(1)
    code = subprocess.run(['curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', '-X', 'PUT', '-H',
                           f"Content-Type: {u['content_type']}", '--data-binary', '@' + d + '/' + name, u['upload_url']],
                          capture_output=True, text=True).stdout
    print(name, u['media_id'], code)
    rows.append(f"{name}\t{u['media_id']}\t{code}")
open(out, 'a').write('\n'.join(rows) + '\n')
