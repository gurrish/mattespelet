import { app, type HttpRequest, type InvocationContext } from "@azure/functions";
import { createHash, randomInt, randomUUID } from "node:crypto";
import {
  PlayerConflictError,
  answerInputSchema,
  forfeitInputSchema,
  gameStartSchema,
  operationsInputSchema,
  playerInputSchema,
  rewardInputSchema,
  tableStartSchema,
  type GameQuestion,
  type Operation,
  type PlayerState,
  type TableChallenge,
} from "./domain.js";
import { createReward, getRepository } from "./repository.js";

interface Identity {
  id: string;
  email: string;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function identity(request: HttpRequest): Identity | undefined {
  const encoded = request.headers.get("x-ms-client-principal");
  if (!encoded && process.env.DEV_AUTH === "true" && process.env.NODE_ENV !== "production") {
    const email = (request.headers.get("x-dev-user-email") || process.env.DEV_AUTH_EMAIL || "").trim().toLowerCase();
    return email ? { id: email, email } : undefined;
  }
  if (!encoded) return undefined;

  try {
    const principal: unknown = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    if (!principal || typeof principal !== "object" || !("userDetails" in principal) || !("userId" in principal)) return undefined;
    const { userDetails, userId } = principal;
    if (typeof userDetails !== "string" || typeof userId !== "string" || !userDetails.includes("@")) return undefined;
    return { id: userId, email: userDetails.trim().toLowerCase() };
  } catch {
    return undefined;
  }
}

function configuredEmails(name: "GLOBAL_ADMIN_EMAILS" | "PLAYER_EMAILS"): Set<string> {
  return new Set((process.env[name] || "").split(",").map((email) => email.trim().toLowerCase()).filter(Boolean));
}

function isAdmin(email: string | undefined): boolean {
  return Boolean(email && configuredEmails("GLOBAL_ADMIN_EMAILS").has(email.toLowerCase()));
}

async function isPlayer(email: string | undefined, repo: ReturnType<typeof getRepository>): Promise<boolean> {
  if (!email) return false;
  const explicitAccess = await repo.getPlayerAccess(email.toLowerCase());
  return explicitAccess ?? configuredEmails("PLAYER_EMAILS").has(email.toLowerCase());
}

function requireIdentity(request: HttpRequest): Identity {
  const actor = identity(request);
  if (!actor) throw new HttpError(401, "Logga in för att använda mattespelet.");
  return actor;
}

function requireAdmin(request: HttpRequest): Identity {
  const actor = requireIdentity(request);
  if (!isAdmin(actor.email)) throw new HttpError(403, "Kontot saknar administratörsbehörighet.");
  return actor;
}

async function requirePlayer(request: HttpRequest, repo: ReturnType<typeof getRepository>): Promise<Identity> {
  const actor = requireIdentity(request);
  if (!await isPlayer(actor.email, repo)) throw new HttpError(403, "E-postadressen har inte tillgång till spelkontot.");
  return actor;
}

function playerKey(id: string): string {
  return createHash("sha256").update(id).digest("hex");
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

async function readBody(request: HttpRequest): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, "Förfrågan innehåller ogiltig JSON.");
  }
}

function responsePath(pathname: string): string[] {
  try {
    return pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    throw new HttpError(400, "Adressen innehåller ogiltig kodning.");
  }
}

function createQuestion(operations: Operation[]): GameQuestion {
  const operation = operations[randomInt(operations.length)];
  let left: number;
  let right: number;
  let points: number;

  if (operation === "multiply") {
    left = randomInt(1, 13);
    right = randomInt(1, 13);
    const high = Math.max(left, right);
    const low = Math.min(left, right);
    points = high >= 9 && low >= 3 ? 3 : high >= 5 && low >= 2 ? 2 : 1;
  } else if (operation === "add") {
    left = randomInt(1, 13);
    right = randomInt(1, 13);
    points = questionPoints(left, right);
  } else if (operation === "subtract") {
    left = randomInt(1, 13);
    right = randomInt(1, left + 1);
    points = questionPoints(left, right);
  } else {
    right = randomInt(2, 13);
    const quotient = randomInt(1, 13);
    const remainder = randomInt(right);
    left = quotient * right + remainder;
    points = questionPoints(quotient, right);
  }

  return { id: randomUUID(), left, right, points, operation };
}

function questionPoints(left: number, right: number): number {
  const largest = Math.max(left, right);
  return largest >= 10 ? 3 : largest >= 5 ? 2 : 1;
}

const TABLE_CHALLENGE_DURATION = 60_000;

function shuffledFactors(): number[] {
  const factors = Array.from({ length: 12 }, (_, index) => index + 1);
  for (let index = factors.length - 1; index > 0; index--) {
    const swapIndex = randomInt(index + 1);
    [factors[index], factors[swapIndex]] = [factors[swapIndex], factors[index]];
  }
  return factors;
}

function createTableChallenge(table: number): TableChallenge {
  return { table, startedAt: Date.now(), factors: shuffledFactors(), index: 0, questionId: randomUUID() };
}

function publicPlayer(player: PlayerState) {
  return {
    points: player.points,
    correctAnswers: player.correctAnswers,
    answeredQuestions: player.answeredQuestions,
    isPlaying: player.activeGameId !== null,
    question: player.question,
    tableChallenge: player.tableChallenge ? {
      table: player.tableChallenge.table,
      startedAt: player.tableChallenge.startedAt,
      index: player.tableChallenge.index,
      questionId: player.tableChallenge.questionId,
      factor: player.tableChallenge.factors[player.tableChallenge.index],
    } : null,
  };
}

export async function handle(request: HttpRequest, context: InvocationContext): Promise<Response> {
  try {
    const segments = responsePath(new URL(request.url).pathname);
    const [api, resource, id, action] = segments;
    if (api !== "api") throw new HttpError(404, "API-adressen hittades inte.");
    const method = request.method.toUpperCase();
    const repo = getRepository();

    if (resource === "me" && method === "GET") {
      const actor = identity(request);
      return json({
        signedIn: Boolean(actor),
        email: actor?.email ?? null,
        isAdmin: isAdmin(actor?.email),
        isPlayer: await isPlayer(actor?.email, repo),
      });
    }

    if (resource === "game") {
      const actor = await requirePlayer(request, repo);
      const key = playerKey(actor.id);
      if (method === "GET" && !id) return json(publicPlayer(await repo.getPlayer(key, actor.email)));
      if (method === "POST" && id === "table" && action === "start") {
        const parsed = tableStartSchema.safeParse(await readBody(request));
        if (!parsed.success) throw new HttpError(400, "Välj en gångertabell mellan 1 och 10.");
        if (!(await repo.getEnabledOperations()).includes("multiply")) {
          throw new HttpError(409, "Tabellutmaningen är inte aktiverad.");
        }
        const player = await repo.updatePlayer(key, actor.email, (current) => {
          const expiredChallenge = current.tableChallenge
            && Date.now() - current.tableChallenge.startedAt >= TABLE_CHALLENGE_DURATION;
          if (current.activeGameId && !expiredChallenge) throw new HttpError(409, "Avsluta det pågående spelet först.");
          return {
            ...current,
            activeGameId: randomUUID(),
            question: null,
            tableChallenge: createTableChallenge(parsed.data.table),
          };
        });
        return json(publicPlayer(player));
      }
      if (method === "POST" && id === "table" && action === "answer") {
        const parsed = answerInputSchema.safeParse(await readBody(request));
        if (!parsed.success) throw new HttpError(400, "Skriv in ett svar mellan 0 och 144.");
        let result: { correct: boolean; correctAnswer: number; complete: boolean; expired: boolean } | undefined;
        let earnedPoints = 0;
        const player = await repo.updatePlayer(key, actor.email, (current) => {
          const challenge = current.tableChallenge;
          if (!current.activeGameId || !challenge || challenge.questionId !== parsed.data.questionId) {
            throw new HttpError(409, "Frågan är inte längre aktiv. Starta tabellutmaningen igen.");
          }
          const correctAnswer = challenge.table * challenge.factors[challenge.index];
          const correct = parsed.data.answer === correctAnswer;
          const expired = Date.now() - challenge.startedAt >= TABLE_CHALLENGE_DURATION;
          const answered = {
            ...current,
            answeredQuestions: current.answeredQuestions + 1,
            correctAnswers: current.correctAnswers + Number(correct),
          };
          if (expired) {
            result = { correct, correctAnswer, complete: false, expired: true };
            return { ...answered, activeGameId: null, tableChallenge: null };
          }
          if (!correct) {
            result = { correct, correctAnswer, complete: false, expired: false };
            return { ...answered, tableChallenge: createTableChallenge(challenge.table) };
          }
          if (challenge.index === challenge.factors.length - 1) {
            earnedPoints = challenge.table <= 2 ? 1 : challenge.table >= 6 && challenge.table <= 9 ? 10 : 5;
            result = { correct, correctAnswer, complete: true, expired: false };
            return { ...answered, points: current.points + earnedPoints, activeGameId: null, tableChallenge: null };
          }
          result = { correct, correctAnswer, complete: false, expired: false };
          return {
            ...answered,
            tableChallenge: {
              ...challenge,
              index: challenge.index + 1,
              questionId: randomUUID(),
            },
          };
        });
        return json({ game: publicPlayer(player), ...result, earnedPoints });
      }
      if (method === "POST" && id === "start" && !action) {
        const parsed = gameStartSchema.safeParse(await readBody(request));
        if (!parsed.success) throw new HttpError(400, "Välj minst ett räknesätt.");
        const enabledOperations = await repo.getEnabledOperations();
        if (parsed.data.operations.some((operation) => !enabledOperations.includes(operation))) {
          throw new HttpError(400, "Ett valt räknesätt är inte aktiverat.");
        }
        const player = await repo.updatePlayer(key, actor.email, (current) => {
          if (current.activeGameId) throw new HttpError(409, "Spelet är redan igång.");
          return {
            ...current,
            activeGameId: randomUUID(),
            activeOperations: parsed.data.operations,
            question: createQuestion(parsed.data.operations),
            tableChallenge: null,
          };
        });
        return json(publicPlayer(player));
      }
      if (method === "POST" && id === "next" && !action) {
        const player = await repo.updatePlayer(key, actor.email, (current) => {
          if (!current.activeGameId || current.tableChallenge) throw new HttpError(409, "Starta ett nytt spel först.");
          if (current.question) return current;
          return { ...current, question: createQuestion(current.activeOperations) };
        });
        return json(publicPlayer(player));
      }
      if (method === "POST" && id === "answer" && !action) {
        const parsed = answerInputSchema.safeParse(await readBody(request));
        if (!parsed.success) throw new HttpError(400, "Skriv in ett svar mellan 0 och 144.");
        let result: { correct: boolean; correctAnswer: number; correctRemainder: number | null; earnedPoints: number } | undefined;
        const player = await repo.updatePlayer(key, actor.email, (current) => {
          const question = current.question;
          if (!current.activeGameId || current.tableChallenge || !question || question.id !== parsed.data.questionId) {
            throw new HttpError(409, "Frågan är inte längre aktiv. Hämta nästa fråga.");
          }
          const correctAnswer = question.operation === "multiply"
            ? question.left * question.right
            : question.operation === "add"
              ? question.left + question.right
              : question.operation === "subtract"
                ? question.left - question.right
                : Math.floor(question.left / question.right);
          const correctRemainder = question.operation === "divide" ? question.left % question.right : null;
          const correct = parsed.data.answer === correctAnswer
            && (question.operation === "divide"
              ? parsed.data.remainder === correctRemainder
              : parsed.data.remainder === undefined);
          const earnedPoints = correct ? question.points : 0;
          result = { correct, correctAnswer, correctRemainder, earnedPoints };
          return {
            ...current,
            points: current.points + earnedPoints,
            correctAnswers: current.correctAnswers + Number(correct),
            answeredQuestions: current.answeredQuestions + 1,
            question: correct ? createQuestion(current.activeOperations) : null,
          };
        });
        return json({ game: publicPlayer(player), ...result });
      }
      if (method === "POST" && id === "forfeit" && !action) {
        const parsed = forfeitInputSchema.safeParse(await readBody(request));
        if (!parsed.success) throw new HttpError(400, "Spelet kunde inte avslutas.");
        let penalty = 0;
        const player = await repo.updatePlayer(key, actor.email, (current) => {
          if (!current.activeGameId) return current;
          penalty = parsed.data.penalize ? Math.min(2, current.points) : 0;
          return { ...current, points: current.points - penalty, activeGameId: null, question: null, tableChallenge: null };
        });
        return json({ game: publicPlayer(player), penalty });
      }
      throw new HttpError(404, "API-adressen hittades inte.");
    }

    if (resource === "players") {
      requireAdmin(request);
      if (method === "GET" && !id) {
        const players = new Map([...configuredEmails("PLAYER_EMAILS")].map((email) => [email, true]));
        for (const access of await repo.listPlayerAccess()) players.set(access.email, access.allowed);
        return json([...players].filter(([, allowed]) => allowed).map(([email]) => email).sort());
      }
      if (method === "POST" && !id) {
        const parsed = playerInputSchema.safeParse(await readBody(request));
        if (!parsed.success) throw new HttpError(400, "Ange en giltig e-postadress.");
        const players = new Map([...configuredEmails("PLAYER_EMAILS")].map((email) => [email, true]));
        for (const access of await repo.listPlayerAccess()) players.set(access.email, access.allowed);
        if (!players.get(parsed.data.email) && [...players.values()].filter(Boolean).length >= 100) {
          throw new HttpError(409, "Gränsen på 100 spelare har nåtts.");
        }
        await repo.setPlayerAccess(parsed.data.email, true);
        return json({ email: parsed.data.email }, 201);
      }
      if (method === "DELETE" && id) {
        const parsed = playerInputSchema.safeParse({ email: id });
        if (!parsed.success) throw new HttpError(400, "Ange en giltig e-postadress.");
        await repo.setPlayerAccess(parsed.data.email, false);
        return json({ ok: true });
      }
      throw new HttpError(404, "API-adressen hittades inte.");
    }

    if (resource === "settings" && id === "operations") {
      const actor = requireIdentity(request);
      if (!isAdmin(actor.email) && !await isPlayer(actor.email, repo)) {
        throw new HttpError(403, "Kontot saknar behörighet att använda spelets inställningar.");
      }
      if (method === "GET" && !action) return json(await repo.getEnabledOperations());
      if (method === "PUT" && !action) {
        requireAdmin(request);
        const parsed = operationsInputSchema.safeParse(await readBody(request));
        if (!parsed.success) throw new HttpError(400, "Välj minst ett räknesätt.");
        await repo.setEnabledOperations(parsed.data.operations);
        return json(parsed.data.operations);
      }
      throw new HttpError(404, "API-adressen hittades inte.");
    }

    if (resource === "rewards") {
      const actor = requireIdentity(request);
      const admin = isAdmin(actor.email);
      const player = await isPlayer(actor.email, repo);
      if (!admin && !player) throw new HttpError(403, "Kontot saknar behörighet att använda belöningarna.");
      if (method === "GET" && !id) {
        const rewards = await repo.listRewards();
        rewards.sort((first, second) => first.cost - second.cost || first.name.localeCompare(second.name, "sv"));
        return json(rewards.filter((reward) => admin || reward.active));
      }
      if (method === "POST" && id && action === "redeem") {
        if (!player) throw new HttpError(403, "Endast spelaren kan lösa in poäng.");
        const reward = await repo.getReward(id);
        if (!reward || !reward.active) throw new HttpError(404, "Belöningen är inte tillgänglig.");
        const key = playerKey(actor.id);
        const redemptionId = randomUUID();
        const redeemedAt = new Date().toISOString();
        const updated = await repo.updatePlayer(key, actor.email, (current) => {
          if (current.points < reward.cost) throw new HttpError(409, "Du har inte tillräckligt med poäng ännu.");
          const redemption = { id: redemptionId, email: actor.email, rewardName: reward.name, cost: reward.cost, redeemedAt };
          return {
            ...current,
            points: current.points - reward.cost,
            redemptions: [...current.redemptions, redemption].slice(-200),
          };
        });
        return json({ points: updated.points, redemption: updated.redemptions.at(-1) }, 201);
      }
      if (!admin) throw new HttpError(403, "Endast administratören kan ändra belöningarna.");
      if (method === "POST" && !id) {
        if ((await repo.listRewards()).length >= 100) throw new HttpError(409, "Gränsen på 100 belöningar har nåtts.");
        const parsed = rewardInputSchema.safeParse(await readBody(request));
        if (!parsed.success) throw new HttpError(400, "Kontrollera belöningens namn och poängpris.");
        const reward = createReward(randomUUID(), parsed.data);
        await repo.saveReward(reward);
        return json(reward, 201);
      }
      if (id && method === "PUT" && !action) {
        if (!await repo.getReward(id)) throw new HttpError(404, "Belöningen hittades inte.");
        const parsed = rewardInputSchema.safeParse(await readBody(request));
        if (!parsed.success) throw new HttpError(400, "Kontrollera belöningens namn och poängpris.");
        const reward = createReward(id, parsed.data);
        await repo.saveReward(reward);
        return json(reward);
      }
      if (id && method === "DELETE" && !action) {
        if (!await repo.getReward(id)) throw new HttpError(404, "Belöningen hittades inte.");
        await repo.deleteReward(id);
        return json({ ok: true });
      }
      throw new HttpError(404, "API-adressen hittades inte.");
    }

    if (resource === "redemptions" && method === "GET" && !id) {
      requireAdmin(request);
      const redemptions = await repo.listRedemptions();
      redemptions.sort((first, second) => second.redeemedAt.localeCompare(first.redeemedAt));
      return json(redemptions.slice(0, 100));
    }
    throw new HttpError(404, "API-adressen hittades inte.");
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message }, error.status);
    if (error instanceof PlayerConflictError) return json({ error: error.message }, 409);
    context.error("Request failed", error);
    return json({ error: "Förfrågan kunde inte behandlas. Försök igen senare." }, 500);
  }
}

app.http("api", {
  route: "{*path}",
  methods: ["GET", "POST", "PUT", "DELETE"],
  authLevel: "anonymous",
  handler: handle,
});
