#!/bin/bash
# Stores one production secret in Parameter Store, where deploy.sh reads it.
#
#   infra/scripts/put-secret.sh MONGODB_URI            prompts; input is not echoed
#   infra/scripts/put-secret.sh JWT_SECRET --generate  32 random bytes, hex
#
# Prompting rather than taking the value as an argument keeps it out of
# your shell history. Takes effect on the next deploy (re-run the
# workflow, or push).
set -euo pipefail

# Git Bash on Windows rewrites any argument starting with / into a Windows
# path, so /porchlight/prod/... would reach AWS as C:/Program Files/Git/...
export MSYS_NO_PATHCONV=1

NAME="${1:?usage: put-secret.sh NAME [--generate] [--force]}"
shift
GENERATE=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --generate) GENERATE=1 ;;
    --force) FORCE=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

REGION="${AWS_REGION:-eu-west-1}"
PARAM="/porchlight/prod/app/$NAME"

# The pepper keys the hash of every claim code in the database. Replacing
# it silently invalidates every unclaimed sticker ever printed, and
# nothing can recover them - so overwriting it takes a second flag.
if [[ "$NAME" == "CLAIM_CODE_PEPPER" && $FORCE -eq 0 ]] &&
  aws ssm get-parameter --region "$REGION" --name "$PARAM" > /dev/null 2>&1; then
  echo "CLAIM_CODE_PEPPER already exists. Replacing it breaks every unclaimed" >&2
  echo "claim code. If that is really what you want, add --force." >&2
  exit 1
fi

if ((GENERATE)); then
  VALUE=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")
else
  read -rsp "Value for $NAME: " VALUE
  echo
fi

if [[ -z "$VALUE" ]]; then
  echo "empty value - nothing stored" >&2
  exit 1
fi

aws ssm put-parameter --region "$REGION" --name "$PARAM" --type SecureString \
  --value "$VALUE" --overwrite > /dev/null
echo "stored $PARAM"
