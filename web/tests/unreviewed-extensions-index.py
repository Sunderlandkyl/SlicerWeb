"""Makes of the published extension index one that gives hashes, with a wrong one and an unreviewed extension.

Usage: prepare.py <extensions folder>; prints the roles as JSON.
"""
import hashlib
import json
import os
import sys

folder = sys.argv[1]
index = json.load(open(os.path.join(folder, "index.json"), encoding="utf8"))
entries = index["extensions"]
for entry in entries:
    entry["sha256"] = hashlib.sha256(open(os.path.join(folder, entry["wheel"]), "rb").read()).hexdigest()
    entry["tier"] = 5
# Extensions that need nothing else, smallest first: quick to install.
alone = sorted((e for e in entries if not e.get("depends") and not e.get("requires")),
               key=lambda e: os.path.getsize(os.path.join(folder, e["wheel"])))
good, wrong, unreviewed = alone[0], alone[1], alone[2]
wrong["sha256"] = "0" * 64
unreviewed["tier"] = 0
json.dump({"extensions": [e for e in entries if e is not unreviewed]}, open(os.path.join(folder, "index.json"), "w"))
json.dump({"extensions": [unreviewed]}, open(os.path.join(folder, "unreviewed.json"), "w"))
print(json.dumps({"good": good["name"], "wrong": wrong["name"], "unreviewed": unreviewed["name"],
                  "unreviewedWheel": unreviewed["wheel"], "all": [e["name"] for e in entries]}))
