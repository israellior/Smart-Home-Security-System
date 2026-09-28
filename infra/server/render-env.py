"""
Turns one Parameter Store path into a compose env file.

    aws ssm get-parameters-by-path ... --output json \
      | python3 render-env.py /porchlight/prod/app app.env NAME [NAME ...]

Every NAME listed is required: if any is missing or empty, nothing is
written and the release stops here, naming them. Better a deploy that
refuses than a server that boots, connects to nothing, and answers 503.

Values are single-quoted, which compose reads literally - so a `$` in a
password is a `$`, not the start of a variable.
"""
import json
import os
import sys

prefix, out, *required = sys.argv[1:]
prefix = prefix.rstrip("/") + "/"

env = {}
for param in json.load(sys.stdin)["Parameters"]:
    env[param["Name"][len(prefix):]] = param["Value"]

missing = [name for name in required if not env.get(name)]
if missing:
    sys.exit(f"Missing from Parameter Store under {prefix}: {', '.join(missing)}\n"
             f"Set each with infra/scripts/put-secret.sh, then redeploy.")

# Single quotes cannot be escaped inside a single-quoted compose value, and
# a newline would end it. Neither belongs in a URI, key or secret here.
unquotable = [name for name, value in env.items() if "'" in value or "\n" in value]
if unquotable:
    sys.exit(f"Cannot write {', '.join(unquotable)}: value contains a quote or newline")

# 0600 from the moment it exists, not chmod'ed afterwards - there is no
# instant where another user could read it.
fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as handle:
    for name in sorted(env):
        handle.write(f"{name}='{env[name]}'\n")
