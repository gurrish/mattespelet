import { app, type HttpRequest, type InvocationContext } from "@azure/functions";
import { createHash, randomInt, randomUUID } from "node:crypto";
import { PlayerConflictError, answerInputSchema, rewardInputSchema, type GameQuestion, type PlayerState } from "./domain.js";
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

function isPlayer(email: string | undefined): boolean {
  return Boolean(email && configuredEmails("PLAYER_EMAILS").has(email.toLowerCase()));
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

function requirePlayer(request: HttpRequest): Identity {
  const actor = requireIdentity(request);
  if (!isPlayer(actor.email)) throw new HttpError(403, "E-postadressen har inte tillgång till spelkontot.");
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

function createQuestion(): GameQuestion {
  const left = randomInt(1, 13);
  const right = randomInt(1, 13);
  const high = Math.max(left, right);
  const low = Math.min(left, right);
  const points = high >= 9 && low >= 3 ? 3 : high >= 5 && low >= 2 ? 2 : 1;
  return { id: randomUUID(), left, right, points };
}

function publicPlayer(player: PlayerState) {
  return {
    points: player.points,
    correctAnswers: player.correctAnswers,
    answeredQuestions: player.answeredQuestions,
    isPlaying: player.activeGameId !== null,
    question: player.question,
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
        isPlayer: isPlayer(actor?.email),
      });
    }

    if (resource === "game") {
      const actor = requirePlayer(request);
      const key = playerKey(actor.id);
      if (method === "GET" && !id) return json(publicPlayer(await repo.getPlayer(key, actor.email)));
      if (method === "POST" && id === "start" && !action) {
        const player = await repo.updatePlayer(key, actor.email, (current) => {
          if (current.activeGameId) throw new HttpError(409, "Spelet är redan igång.");
          return { ...current, activeGameId: randomUUID(), question: createQuestion() };
        });
        return json(publicPlayer(player));
      }
      if (method === "POST" && id === "next" && !action) {
        const player = await repo.updatePlayer(key, actor.email, (current) => {
          if (!current.activeGameId) throw new HttpError(409, "Starta ett nytt spel först.");
          if (current.question) return current;
          return { ...current, question: createQuestion() };
        });
        return json(publicPlayer(player));
      }
      if (method === "POST" && id === "answer" && !action) {
        const parsed = answerInputSchema.safeParse(await readBody(request));
        if (!parsed.success) throw new HttpError(400, "Skriv in ett svar mellan 0 och 144.");
        let result: { correct: boolean; correctAnswer: number; earnedPoints: number } | undefined;
        const player = await repo.updatePlayer(key, actor.email, (current) => {
          const question = current.question;
          if (!current.activeGameId || !question || question.id !== parsed.data.questionId) {
            throw new HttpError(409, "Frågan är inte längre aktiv. Hämta nästa fråga.");
          }
          const correctAnswer = question.left * question.right;
          const correct = parsed.data.answer === correctAnswer;
          const earnedPoints = correct ? question.points : 0;
          result = { correct, correctAnswer, earnedPoints };
          return {
            ...current,
            points: current.points + earnedPoints,
            correctAnswers: current.correctAnswers + Number(correct),
            answeredQuestions: current.answeredQuestions + 1,
            question: null,
          };
        });
        return json({ game: publicPlayer(player), ...result });
      }
      if (method === "POST" && id === "forfeit" && !action) {
        let penalty = 0;
        const player = await repo.updatePlayer(key, actor.email, (current) => {
          if (!current.activeGameId) return current;
          penalty = Math.min(2, current.points);
          return { ...current, points: current.points - penalty, activeGameId: null, question: null };
        });
        return json({ game: publicPlayer(player), penalty });
      }
      throw new HttpError(404, "API-adressen hittades inte.");
    }

    if (resource === "rewards") {
      const actor = requireIdentity(request);
      const admin = isAdmin(actor.email);
      const player = isPlayer(actor.email);
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
