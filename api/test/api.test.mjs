import assert from "node:assert/strict";
import { test } from "node:test";

process.env.STORAGE_MODE = "memory";
process.env.DEV_AUTH = "true";
process.env.NODE_ENV = "development";
process.env.GLOBAL_ADMIN_EMAILS = "admin@local.test";
process.env.PLAYER_EMAILS = "daughter@local.test";

const { handle } = await import("../dist/src/index.js");
const context = { error: (...args) => { throw new Error(`Unexpected API error: ${args.join(" ")}`); } };
const adminHeaders = { "x-dev-user-email": "admin@local.test" };
const playerHeaders = { "x-dev-user-email": "daughter@local.test" };

function request(path, method = "GET", headers = {}, body) {
  return new Request(`http://localhost${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
  });
}

test("authenticated player can play, earn points, and redeem an admin-created reward", async () => {
  assert.equal((await handle(request("/api/game"), context)).status, 401);
  assert.equal((await handle(request("/api/game", "GET", { "x-dev-user-email": "stranger@local.test" }), context)).status, 403);
  assert.deepEqual(await (await handle(request("/api/me", "GET", playerHeaders), context)).json(), {
    signedIn: true,
    email: "daughter@local.test",
    isAdmin: false,
    isPlayer: true,
  });

  const deniedReward = await handle(request("/api/rewards", "POST", {
    ...playerHeaders,
    "content-type": "application/json",
  }, JSON.stringify({ name: "Glass", cost: 1, active: true })), context);
  assert.equal(deniedReward.status, 403);

  const createdReward = await handle(request("/api/rewards", "POST", {
    ...adminHeaders,
    "content-type": "application/json",
  }, JSON.stringify({ name: "Godis", cost: 1, active: true })), context);
  assert.equal(createdReward.status, 201);
  const reward = await createdReward.json();

  const highCostReward = await handle(request("/api/rewards", "POST", {
    ...adminHeaders,
    "content-type": "application/json",
  }, JSON.stringify({ name: "Stor belöning", cost: 5000, active: true })), context);
  assert.equal(highCostReward.status, 201);
  assert.equal((await highCostReward.json()).cost, 5000);

  const overLimitReward = await handle(request("/api/rewards", "POST", {
    ...adminHeaders,
    "content-type": "application/json",
  }, JSON.stringify({ name: "För dyr", cost: 5001, active: true })), context);
  assert.equal(overLimitReward.status, 400);

  const firstGame = await handle(request("/api/game/start", "POST", playerHeaders), context);
  assert.equal(firstGame.status, 200);
  const initialGame = await firstGame.json();
  assert.equal(initialGame.isPlaying, true);
  assert.ok(initialGame.question.id);
  assert.ok(initialGame.question.points >= 1 && initialGame.question.points <= 3);

  const repeatedStart = await handle(request("/api/game/start", "POST", playerHeaders), context);
  assert.equal(repeatedStart.status, 409);

  const wrongAnswer = await handle(request("/api/game/answer", "POST", {
    ...playerHeaders,
    "content-type": "application/json",
  }, JSON.stringify({ questionId: initialGame.question.id, answer: -1 })), context);
  assert.equal(wrongAnswer.status, 400);

  const correctAnswer = initialGame.question.left * initialGame.question.right;
  const answered = await handle(request("/api/game/answer", "POST", {
    ...playerHeaders,
    "content-type": "application/json",
  }, JSON.stringify({ questionId: initialGame.question.id, answer: correctAnswer })), context);
  assert.equal(answered.status, 200);
  const result = await answered.json();
  assert.equal(result.correct, true);
  assert.equal(result.correctAnswer, correctAnswer);
  assert.equal(result.earnedPoints, initialGame.question.points);
  assert.equal(result.game.points, initialGame.question.points);
  assert.equal(result.game.question, null);

  const replayedAnswer = await handle(request("/api/game/answer", "POST", {
    ...playerHeaders,
    "content-type": "application/json",
  }, JSON.stringify({ questionId: initialGame.question.id, answer: correctAnswer })), context);
  assert.equal(replayedAnswer.status, 409);

  const next = await handle(request("/api/game/next", "POST", playerHeaders), context);
  assert.equal(next.status, 200);
  const nextGame = await next.json();
  assert.notEqual(nextGame.question.id, initialGame.question.id);

  const forfeited = await handle(request("/api/game/forfeit", "POST", playerHeaders), context);
  assert.equal(forfeited.status, 200);
  const forfeitedGame = await forfeited.json();
  assert.equal(forfeitedGame.penalty, Math.min(2, initialGame.question.points));
  assert.equal(forfeitedGame.game.points, initialGame.question.points - forfeitedGame.penalty);
  assert.equal(forfeitedGame.game.isPlaying, false);

  const repeatedForfeit = await handle(request("/api/game/forfeit", "POST", playerHeaders), context);
  assert.equal((await repeatedForfeit.json()).penalty, 0);

  const earnedMore = await handle(request("/api/game/start", "POST", playerHeaders), context);
  const earningGame = await earnedMore.json();
  const secondEarn = await handle(request("/api/game/answer", "POST", {
    ...playerHeaders,
    "content-type": "application/json",
  }, JSON.stringify({
    questionId: earningGame.question.id,
    answer: earningGame.question.left * earningGame.question.right,
  })), context);
  const earned = await secondEarn.json();
  const beforeRedemption = earned.game.points;
  assert.ok(beforeRedemption >= 1);

  const redeemed = await handle(request(`/api/rewards/${reward.id}/redeem`, "POST", playerHeaders), context);
  assert.equal(redeemed.status, 201);
  const redemption = await redeemed.json();
  assert.equal(redemption.points, beforeRedemption - reward.cost);
  assert.equal(redemption.redemption.rewardName, "Godis");

  const listedRewards = await handle(request("/api/rewards", "GET", playerHeaders), context);
  assert.equal((await listedRewards.json()).length, 2);
  const listedRedemptions = await handle(request("/api/redemptions", "GET", adminHeaders), context);
  assert.equal((await listedRedemptions.json()).length, 1);
});
