# Photo Notes — Azure Deployment Guide

## Overview

This guide walks you through deploying the **Photo Notes** app (Node.js + Express + PostgreSQL) to Azure, covering all 4 parts of Homework Assignment #2.

---

## Prerequisites

- Azure for Students subscription (or free trial)
- [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli) installed
- [Node.js 18+](https://nodejs.org/) installed
- A GitHub account
- Git installed

Login to Azure CLI:
```bash
az login
```

Create a resource group (use a region near you, e.g., `westeurope`):
```bash
az group create --name rg-photo-notes --location westeurope
```

---

## Part 1: Deploy PostgreSQL Database (5 pts)

We'll use **Azure Database for PostgreSQL — Flexible Server** with the cheapest burstable tier.

```bash
az postgres flexible-server create \
  --resource-group rg-photo-notes \
  --name photonotes-db \
  --location westeurope \
  --admin-user photoadmin \
  --admin-password '<YourStrongPassword123!>' \
  --sku-name Standard_B1ms \
  --tier Burstable \
  --storage-size 32 \
  --version 16 \
  --public-access 0.0.0.0-255.255.255.255
```

> **Note:** `Standard_B1ms` is the cheapest burstable tier. The `--public-access 0.0.0.0-255.255.255.255` allows Azure services to connect (you'll restrict this later).

Create the database:
```bash
az postgres flexible-server db create \
  --resource-group rg-photo-notes \
  --server-name photonotes-db \
  --database-name photonotes
```

Your connection string will be:
```
postgresql://photoadmin:<YourPassword>@photonotes-db.postgres.database.azure.com:5432/photonotes?sslmode=require
```

---

## Part 2: Deploy Web App to Azure App Service (7.5 pts)

Create an App Service Plan (Free tier) and Web App:

```bash
# Create Free-tier App Service Plan
az appservice plan create \
  --name plan-photo-notes \
  --resource-group rg-photo-notes \
  --sku F1 \
  --is-linux

# Create Web App (Node 20)
az webapp create \
  --name photo-notes-app \
  --resource-group rg-photo-notes \
  --plan plan-photo-notes \
  --runtime "NODE:20-lts"
```

> **Important:** App names must be globally unique. If `photo-notes-app` is taken, choose another name and update it everywhere.

Set the environment variables:
```bash
az webapp config appsettings set \
  --name photo-notes-app \
  --resource-group rg-photo-notes \
  --settings \
    NODE_ENV=production \
    DATABASE_URL="postgresql://photoadmin:<YourPassword>@photonotes-db.postgres.database.azure.com:5432/photonotes?sslmode=require" \
    AZURE_STORAGE_CONNECTION_STRING="<from Part 3>" \
    AZURE_STORAGE_CONTAINER=uploads \
    AZURE_STATIC_CONTAINER=static \
    AZURE_STATIC_URL="https://<storageaccount>.blob.core.windows.net/static"
```

### Quick deploy (before CI/CD is set up):
```bash
# From the photo-notes project directory
zip -r deploy.zip . -x "node_modules/*" ".git/*" ".env"
az webapp deploy \
  --name photo-notes-app \
  --resource-group rg-photo-notes \
  --src-path deploy.zip \
  --type zip
```

Your app will be live at: `https://photo-notes-app.azurewebsites.net`

---

## Part 3: Static Files in Azure Blob Storage (5 pts)

### 3a. Create Storage Account

```bash
az storage account create \
  --name photonotesstorage \
  --resource-group rg-photo-notes \
  --location westeurope \
  --sku Standard_LRS \
  --kind StorageV2
```

> **Note:** Storage account names must be globally unique, lowercase, 3–24 chars.

### 3b. Create containers

```bash
# Static files container (public read)
az storage container create \
  --name static \
  --account-name photonotesstorage \
  --public-access blob \
  --auth-mode login

# Uploads container (private — SAS tokens used for access)
az storage container create \
  --name uploads \
  --account-name photonotesstorage \
  --public-access off \
  --auth-mode login
```

### 3c. Upload static files

```bash
# Upload CSS
az storage blob upload-batch \
  --account-name photonotesstorage \
  --destination static/static \
  --source ./public \
  --overwrite true \
  --auth-mode login
```

### 3d. Get Storage connection string

```bash
az storage account show-connection-string \
  --name photonotesstorage \
  --resource-group rg-photo-notes \
  --output tsv
```

Use this value to set `AZURE_STORAGE_CONNECTION_STRING` in App Service settings (Part 2).

Set the static URL:
```
AZURE_STATIC_URL = https://photonotesstorage.blob.core.windows.net/static
```

### 3e. How the Valet Key (SAS Token) Pattern Works

The app implements the valet key pattern for user-uploaded images:

1. **Upload**: When a user uploads an image, it's stored in the `uploads` container (private, no public access).
2. **Storage**: Only the blob name is saved in the database (not a full URL).
3. **Access**: When a note is displayed, the server generates a **time-limited SAS token** (30 min) granting read-only access to that specific blob.
4. **Security**: The SAS URL expires after 30 minutes. Even if someone copies the URL, it becomes invalid.

Key code in `app.js`:
```javascript
function generateSasUrl(blobName) {
  const sasOptions = {
    containerName,
    blobName,
    permissions: BlobSASPermissions.parse('r'),  // read-only
    startsOn: new Date(),
    expiresOn: new Date(new Date().valueOf() + 30 * 60 * 1000), // 30 min
  };
  const sasToken = generateBlobSASQueryParameters(sasOptions, credential).toString();
  return `${blobClient.url}?${sasToken}`;
}
```

---

## Part 4: CI/CD with GitHub Actions (5 pts)

### 4a. Push code to GitHub

```bash
cd photo-notes
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/<your-username>/photo-notes.git
git branch -M main
git push -u origin main
```

### 4b. Set up GitHub Secrets

You need two secrets in your GitHub repo (Settings → Secrets → Actions):

**1. `AZURE_WEBAPP_PUBLISH_PROFILE`:**
```bash
az webapp deployment list-publishing-profiles \
  --name photo-notes-app \
  --resource-group rg-photo-notes \
  --xml
```
Copy the entire XML output and save it as the secret.

**2. `AZURE_CREDENTIALS`** (for Blob Storage deployment):
```bash
az ad sp create-for-rbac \
  --name "photo-notes-github" \
  --role contributor \
  --scopes /subscriptions/<subscription-id>/resourceGroups/rg-photo-notes \
  --sdk-auth
```
Copy the JSON output and save it as the secret.

### 4c. Update workflow file

Edit `.github/workflows/deploy.yml` and update:
- `AZURE_WEBAPP_NAME` → your actual App Service name
- `AZURE_STORAGE_ACCOUNT` → your actual storage account name

### 4d. Test the pipeline

Make a small change (e.g., update a CSS color), commit, and push:
```bash
git add .
git commit -m "Update styling"
git push
```

Go to GitHub → Actions tab to see the pipeline run. It will:
1. Install dependencies
2. Upload static files to Blob Storage
3. Deploy the app to Azure App Service

---

## Part 5 (Bonus): Managed Identity — Secretless Config (5 pts)

### 5a. Enable Managed Identity

```bash
az webapp identity assign \
  --name photo-notes-app \
  --resource-group rg-photo-notes
```

Note the `principalId` from the output.

### 5b. Grant database access

```bash
# Install the rdbms-connect extension
az extension add --name rdbms-connect

# Create an Entra AD admin on the PostgreSQL server
az postgres flexible-server ad-admin create \
  --resource-group rg-photo-notes \
  --server-name photonotes-db \
  --display-name photo-notes-app \
  --object-id <principalId-from-above>
```

### 5c. Grant Storage access

```bash
# Get the principal ID
PRINCIPAL_ID=$(az webapp identity show --name photo-notes-app --resource-group rg-photo-notes --query principalId -o tsv)

# Grant "Storage Blob Data Contributor" role
az role assignment create \
  --assignee $PRINCIPAL_ID \
  --role "Storage Blob Data Contributor" \
  --scope /subscriptions/<sub-id>/resourceGroups/rg-photo-notes/providers/Microsoft.Storage/storageAccounts/photonotesstorage
```

### 5d. Update app code

For Managed Identity, you'd replace connection strings with `@azure/identity`:
```javascript
const { DefaultAzureCredential } = require('@azure/identity');
const credential = new DefaultAzureCredential();

// For Blob Storage:
const blobServiceClient = new BlobServiceClient(
  `https://${accountName}.blob.core.windows.net`,
  credential
);

// For PostgreSQL: use azure-identity token-based auth
```

> **Note:** This is more complex to implement. Only attempt if you're comfortable with it. Verify your Node.js `pg` driver version supports Entra ID token auth.

---

## Sharing with Instructor

```bash
az role assignment create \
  --assignee "255653@muni.cz" \
  --role "Reader" \
  --scope /subscriptions/<sub-id>/resourceGroups/rg-photo-notes
```

---

## Checklist

- [ ] PostgreSQL Flexible Server running (Burstable tier)
- [ ] App Service on Free F1 plan, publicly accessible
- [ ] Static files (CSS/JS) served from Blob Storage
- [ ] User uploads stored in private Blob container with SAS tokens
- [ ] GitHub Actions pipeline deploys both app and static files
- [ ] Resource Group shared with instructor (Reader)
- [ ] PDF with screenshots submitted

---

## File Structure

```
photo-notes/
├── app.js                  # Main Express application
├── package.json
├── .env.example            # Environment variables template
├── .gitignore
├── upload-static.sh        # Manual static upload script
├── views/
│   ├── index.ejs           # Home page - list notes
│   ├── new.ejs             # Create note form
│   └── error.ejs           # Error page
├── public/
│   ├── css/style.css       # Stylesheet (→ Blob Storage)
│   └── js/app.js           # Client JS (→ Blob Storage)
└── .github/
    └── workflows/
        └── deploy.yml      # CI/CD pipeline
```
