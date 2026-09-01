#!/usr/bin/env bash
# =============================================================================
# FAPOMS - one-command infrastructure deploy for ANY AWS account.
#
# Provisions the CloudFormation stack into YOUR account and region. Nothing here
# is tied to the account it was authored in.
#
#   ./deploy/aws/deploy.sh saving     # minimal-cost app stack (default)
#   ./deploy/aws/deploy.sh full       # + self-hosted ClamAV, Nominatim, OSRM (bigger box)
#   ./deploy/aws/deploy.sh saving --preview   # build a change set to review, create nothing
#
# The mode picks sensible instance size + disk defaults (override with env vars).
# It also passes the mode to the stack; you then use the SAME mode when you run
# bootstrap.sh on the box, so infra and app agree on what's running.
#
# Required:  export ALERT_EMAIL="you@example.com"
# Optional:  AWS_PROFILE  AWS_REGION  INSTANCE_TYPE  ROOT_VOLUME_GB  BUDGET_USD  STACK_NAME
#
# Prereqs: AWS CLI v2 + credentials for your account (aws configure / SSO / env keys).
# The agent-toolkit / `aws login` setup is NOT needed to deploy.
# =============================================================================
set -euo pipefail

MODE="saving"
PREVIEW=""
for arg in "$@"; do
  case "$arg" in
    full|saving) MODE="$arg" ;;
    --preview)   PREVIEW="--no-execute-changeset" ;;
    *) echo "Unknown argument: $arg  (use: full | saving | --preview)"; exit 2 ;;
  esac
done

# Mode-driven defaults (each overridable by an env var of the same name).
if [ "$MODE" = "full" ]; then
  INSTANCE_TYPE="${INSTANCE_TYPE:-t4g.xlarge}"     # OSRM + Nominatim need the RAM
  ROOT_VOLUME_GB="${ROOT_VOLUME_GB:-250}"          # India OSM extract + Nominatim DB + OSRM graph
  BUDGET_USD="${BUDGET_USD:-140}"
else
  INSTANCE_TYPE="${INSTANCE_TYPE:-t4g.large}"
  ROOT_VOLUME_GB="${ROOT_VOLUME_GB:-60}"
  BUDGET_USD="${BUDGET_USD:-75}"
fi

STACK_NAME="${STACK_NAME:-fapoms}"
AWS_REGION="${AWS_REGION:-ap-south-1}"
ALERT_EMAIL="${ALERT_EMAIL:?Set ALERT_EMAIL - the budget alarm needs somewhere to warn you.}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="$HERE/fapoms-stack.yaml"

PROFILE_ARG=()
[ -n "${AWS_PROFILE:-}" ] && PROFILE_ARG=(--profile "$AWS_PROFILE")

echo "=========================================================="
echo " FAPOMS deploy"
echo "   mode:      $MODE"
echo "   instance:  $INSTANCE_TYPE   disk: ${ROOT_VOLUME_GB} GB"
echo "   region:    $AWS_REGION${AWS_PROFILE:+   profile: $AWS_PROFILE}"
echo "   account:   $(aws sts get-caller-identity "${PROFILE_ARG[@]}" --query Account --output text 2>/dev/null || echo '??? check your credentials')"
echo "   budget:    \$${BUDGET_USD}/mo  ->  $ALERT_EMAIL"
[ -n "$PREVIEW" ] && echo "   PREVIEW ONLY - a change set is created; nothing is built."
echo "=========================================================="

aws cloudformation deploy \
  --template-file "$TEMPLATE" \
  --stack-name "$STACK_NAME" \
  --region "$AWS_REGION" \
  "${PROFILE_ARG[@]}" \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
      DeployMode="$MODE" \
      AlertEmail="$ALERT_EMAIL" \
      InstanceType="$INSTANCE_TYPE" \
      RootVolumeSizeGb="$ROOT_VOLUME_GB" \
      BudgetLimitUsd="$BUDGET_USD" \
  $PREVIEW

[ -n "$PREVIEW" ] && { echo "Change set created - review it in the CloudFormation console, then run without --preview."; exit 0; }

echo ""
echo "==> Stack outputs:"
aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --region "$AWS_REGION" "${PROFILE_ARG[@]}" \
  --query 'Stacks[0].Outputs[].{Key:OutputKey,Value:OutputValue}' --output table

echo ""
echo "Next (see deploy/aws/README.md from 'Bring the app up'):"
echo "  1. Connect with the ConnectCommand above (SSM - no SSH)."
echo "  2. Get the code onto the box."
echo "  3. Run bootstrap in the SAME mode:"
echo "       export PUBLIC_IP=<Elastic IP>  S3_BUCKET=<bucket>  AWS_REGION=$AWS_REGION  MODE=$MODE"
echo "       bash /opt/fapoms/deploy/aws/bootstrap.sh"
