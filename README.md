# Mattespelet

Mattespelet is a Swedish, phone-friendly multiplication game for the 1–12 times tables. A player answers questions to earn 1–3 points; more challenging questions are worth more. Points can be redeemed for rewards set up by an administrator.

## Sign-in and game rules

- The app uses Azure Static Web Apps' Microsoft sign-in (`/.auth/login/aad`). The player's email must be listed in `PLAYER_EMAILS`; administrator emails go in `GLOBAL_ADMIN_EMAILS`. Configure both as comma-separated addresses. No email addresses are stored in frontend code.
- The API creates each question, checks the answer, updates the score and redeems points server-side. Repeated or stale answers cannot score twice.
- If Safari reports that the game page became hidden or was left during an active round, the round ends and up to 2 points are deducted. The browser can detect that the page was backgrounded, but cannot tell whether the calculator specifically was opened; this is a gentle deterrent, not tamper-proof monitoring. A phone call or another interruption may also end a round.
- Azure Table Storage stores player scores, rewards and redemption history. The app does not use a client-side score or store Microsoft credentials.

## Local development

Prerequisites: Node.js 22+, npm, Azure Functions Core Tools v4 and Azurite.

1. Install dependencies:

   ```powershell
   npm ci
   Set-Location api
   npm ci
   ```

2. Copy `api/local.settings.example.json` to `api/local.settings.json`. Set `PLAYER_EMAILS` to `daughter@local.test` and `GLOBAL_ADMIN_EMAILS` to `admin@local.test` for local testing.
3. Start Azurite, then start the Functions API:

   ```powershell
   Set-Location api
   npm run build
   func start
   ```

4. In another terminal, run `npm run dev`. The local sign-in prompt accepts an address in either configured email list.

Local memory storage is used by default; data is lost when the Functions process restarts. To test Azure Table persistence locally, set `STORAGE_MODE` to `table` and configure `STORAGE_CONNECTION_STRING` in the untracked local settings file.

## Build and tests

```powershell
npm run build
Set-Location api
npm test
```

## Azure deployment

The Bicep template provisions Azure Static Web Apps, Storage Account and Application Insights. GitHub Actions deploys the app and infrastructure using OIDC; no client secret is needed. Deployment is not performed just because the templates are present.

Configure the GitHub repository with the Azure OIDC secrets `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, and `SWA_DEPLOYMENT_TOKEN`, and variables `AZURE_RESOURCE_GROUP`, `GLOBAL_ADMIN_EMAILS`, and `PLAYER_EMAILS`. `NAME_PREFIX` is optional and defaults to `mattespelet`. Both email variables accept comma-separated addresses. The `PLAYER_EMAILS` value must include the player's Microsoft sign-in email.

The current app uses the existing Static Web Apps Microsoft provider. Confirm that the daughter's Microsoft 365 account can sign in to the deployed app; if the account belongs to a different tenant or is a personal Microsoft account not accepted by the provider, configure an appropriate Entra identity provider before relying on sign-in.

To deploy infrastructure locally after configuring Azure CLI:

```powershell
az login
az deployment group create `
  --resource-group <resource-group> `
  --template-file infra/main.bicep `
  --parameters namePrefix=mattespelet globalAdminEmails=<admin-email> playerEmails=<player-email>
```

## Project layout

- `src/App.tsx`: Swedish player experience and administrator reward management.
- `src/lib/api.ts`: typed browser API calls.
- `api/src/index.ts`: trusted Static Web Apps identity checks and game/reward API.
- `api/src/repository.ts`: in-memory development storage and Azure Table Storage persistence.
- `infra/`: Azure resources and server-side app settings.
