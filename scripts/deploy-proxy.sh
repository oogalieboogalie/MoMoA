#!/bin/bash
set -e

REVISION_TAG="$1"
IMAGE_TAG=latest
PROJECT_ID=threeplabs
IMAGE_NAME=cloud-run-agent-proxy
SERVICE_NAME=cloud-run-agent-proxy
REGION=us-central1
EXTRA_DEPLOY_FLAGS=()

# The path to your proxy server files, relative to the project root
PROXY_SOURCE_DIR="src/services/agentOrchestrators/agentWorkers/cloudRunAgentProxyServer"

if [[ -z "$REVISION_TAG" ]]; then
  echo "Deploying to prod in 3 seconds... (Ctrl+C to cancel)"
  sleep 3
else
  IMAGE_TAG="$REVISION_TAG"
  EXTRA_DEPLOY_FLAGS=(--no-traffic --tag "$REVISION_TAG")
  echo "Deploying to revision \"$REVISION_TAG\""
fi

IMAGE=gcr.io/${PROJECT_ID}/${IMAGE_NAME}:${IMAGE_TAG}

echo "Building custom image: $IMAGE"

# Pass the specific directory to Cloud Build instead of "."
gcloud builds submit \
  --project $PROJECT_ID \
  --tag $IMAGE \
  "$PROXY_SOURCE_DIR"

echo "Deploying Cloud Run Service: $SERVICE_NAME"
gcloud run deploy $SERVICE_NAME \
  --project $PROJECT_ID \
  --image $IMAGE \
  --region $REGION \
  --memory 2Gi \
  --cpu 2 \
  --execution-environment gen2 \
  --no-allow-unauthenticated \
  --session-affinity \
  "${EXTRA_DEPLOY_FLAGS[@]}"

echo "Deployment complete."

# Fetch and print the deployed service URL
echo "Fetching deployed service URL..."
SERVICE_URL=$(gcloud run services describe $SERVICE_NAME \
  --project $PROJECT_ID \
  --region $REGION \
  --format 'value(status.url)')

echo ""
echo "====================================================="
echo "Cloud Run Agent Proxy URL:"
echo "$SERVICE_URL"
echo ""
echo "Pass this to your CLI using:"
echo "--cloud-run-proxy-url \"$SERVICE_URL\""
echo "====================================================="