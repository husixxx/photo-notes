#!/bin/bash
# Upload static files to Azure Blob Storage
# Usage: ./upload-static.sh <storage-account-name>

STORAGE_ACCOUNT=${1:?"Usage: ./upload-static.sh <storage-account-name>"}

echo "Creating 'static' container (public read access for blobs)..."
az storage container create \
  --name static \
  --account-name "$STORAGE_ACCOUNT" \
  --public-access blob \
  --auth-mode login

echo "Uploading static files..."
az storage blob upload-batch \
  --account-name "$STORAGE_ACCOUNT" \
  --destination static/static \
  --source ./public \
  --overwrite true \
  --auth-mode login \
  --content-type "" \
  --pattern "css/*" \
  --content-type "text/css"

az storage blob upload-batch \
  --account-name "$STORAGE_ACCOUNT" \
  --destination static/static \
  --source ./public \
  --overwrite true \
  --auth-mode login \
  --pattern "js/*" \
  --content-type "application/javascript"

echo ""
echo "Done! Your static URL is:"
echo "https://${STORAGE_ACCOUNT}.blob.core.windows.net/static"
echo ""
echo "Set this as AZURE_STATIC_URL in your App Service configuration."
