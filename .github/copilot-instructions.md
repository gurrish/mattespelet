# Copilot instructions

## Project overview

Mattespelet is a Swedish, mobile-friendly multiplication game for the 1–12 times tables. Players earn 1–3 server-validated points per correct answer and can redeem points for rewards configured by an administrator. The game uses Microsoft sign-in through Azure Static Web Apps.

The frontend is React, TypeScript and Vite. The backend is an Azure Functions API integrated with Azure Static Web Apps. Azure Table Storage holds player scores, rewards and redemption history. Azure resources use Bicep and GitHub Actions deploy with OIDC.

## Project structure

- `src/App.tsx`: player game and administrator reward management.
- `src/lib/api.ts`: typed browser API calls.
- `src/types.ts`: shared game, reward, player and identity types.
- `api/src/domain.ts`: Zod schemas and server-side types.
- `api/src/index.ts`: trusted Static Web Apps identity parsing, authorization, question generation, scoring and redemption.
- `api/src/repository.ts`: in-memory development repository and Azure Table Storage persistence.
- `infra/`: Bicep entry point and resource modules.
- `.github/workflows/`: application and infrastructure build/deploy workflows.
- `README.md`: local setup, game rules, API and deployment documentation.

## Code conventions

- Use TypeScript and preserve strict type checking. Avoid `any` and unsafe casts.
- All visible UI text, accessibility labels, validation messages and page metadata must be in Swedish.
- Validate API inputs with Zod. Return actionable client errors and log unexpected failures.
- Keep persistence behind the `Repository` interface and implement both memory and Azure-backed behavior.
- Scores, answers, rewards and redemptions must be validated and updated server-side; never trust a client-supplied score.
- Only emails listed in `PLAYER_EMAILS` may play. Only trusted emails listed in `GLOBAL_ADMIN_EMAILS` may manage rewards or view redemption history. `x-dev-user-email` is accepted only when `DEV_AUTH=true` and `NODE_ENV` is not `production`.
- Page visibility is a deterrent, not proof of calculator use. Do not claim that the browser can identify which app caused the page to become hidden.

## Build and validation

- Frontend: `npm ci` then `npm run build` from the repository root.
- Functions API: `npm ci` then `npm test` from `api/`.
- Infrastructure: `az bicep build --file infra/main.bicep`.
- Run `git diff --check` before finishing.
- Keep root and API lockfiles committed when dependencies change. Do not commit generated build output, local Functions settings, secrets, or Azure credentials.

## Infrastructure and deployment

- Define Azure resources in Bicep under `infra/`.
- Keep Static Web Apps integrated Functions and GitHub OIDC federation; do not add a client-secret requirement.
- The Functions app uses a server-side Storage connection string for Table Storage. Never put credentials in frontend code, repository files, workflow arguments, or responses.
- Infrastructure is not necessarily deployed just because Bicep templates exist; state deployment status explicitly.
