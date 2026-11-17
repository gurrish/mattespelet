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
  assert.ok(result.game.question);
  assert.notEqual(result.game.question.id, initialGame.question.id);

  const replayedAnswer = await handle(request("/api/game/answer", "POST", {
    ...playerHeaders,
    "content-type": "application/json",
  }, JSON.stringify({ questionId: initialGame.question.id, answer: correctAnswer })), context);
  assert.equal(replayedAnswer.status, 409);

  const forfeited = await handle(request("/api/game/forfeit", "POST", {
    ...playerHeaders,
    "content-type": "application/json",
  }, JSON.stringify({ penalize: true })), context);
  assert.equal(forfeited.status, 200);
  const forfeitedGame = await forfeited.json();
  assert.equal(forfeitedGame.penalty, Math.min(2, initialGame.question.points));
  assert.equal(forfeitedGame.game.points, initialGame.question.points - forfeitedGame.penalty);
  assert.equal(forfeitedGame.game.isPlaying, false);

  const repeatedForfeit = await handle(request("/api/game/forfeit", "POST", {
    ...playerHeaders,
    "content-type": "application/json",
  }, JSON.stringify({ penalize: true })), context);
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

  const leaveWithoutPenalty = await handle(request("/api/game/forfeit", "POST", {
    ...playerHeaders,
    "content-type": "application/json",
  }, JSON.stringify({ penalize: false })), context);
  const leftGame = await leaveWithoutPenalty.json();
  assert.equal(leftGame.penalty, 0);
  assert.equal(leftGame.game.points, beforeRedemption - reward.cost);
  const invalidTable = await handle(request("/api/game/table/start", "POST", {
    ...playerHeaders,
    "content-type": "application/json",
  }, JSON.stringify({ table: 13 })), context);
  assert.equal(invalidTable.status, 400);

  const startedChallenge = await handle(request("/api/game/table/start", "POST", {
    ...playerHeaders,
    "content-type": "application/json",
  }, JSON.stringify({ table: 6 })), context);
  let challengeGame = await startedChallenge.json();
  const tablePointsBefore = challengeGame.points;
  const firstTableQuestion = challengeGame.tableChallenge;
  const originalNow = Date.now;
  let restartedChallenge;
  try {
    Date.now = () => firstTableQuestion.startedAt + 1_000;
    const wrongTableAnswer = await handle(request("/api/game/table/answer", "POST", {
      ...playerHeaders,
      "content-type": "application/json",
    }, JSON.stringify({ questionId: firstTableQuestion.questionId, answer: 0 })), context);
    restartedChallenge = await wrongTableAnswer.json();
  } finally {
    Date.now = originalNow;
  }
  assert.equal(restartedChallenge.correct, false);
  assert.equal(restartedChallenge.game.tableChallenge.index, 0);
  assert.notEqual(restartedChallenge.game.tableChallenge.questionId, firstTableQuestion.questionId);
  assert.equal(restartedChallenge.game.tableChallenge.startedAt, firstTableQuestion.startedAt + 1_000);

  challengeGame = restartedChallenge.game;
  let tableResult;
  for (let index = 0; index < 12; index++) {
    const current = challengeGame.tableChallenge;
    tableResult = await handle(request("/api/game/table/answer", "POST", {
      ...playerHeaders,
      "content-type": "application/json",
    }, JSON.stringify({ questionId: current.questionId, answer: 6 * current.factor })), context);
    tableResult = await tableResult.json();
    challengeGame = tableResult.game;
  }
  assert.equal(tableResult.complete, true);
  assert.equal(tableResult.earnedPoints, 10);
  assert.equal(challengeGame.points, tablePointsBefore + 10);
  assert.equal(challengeGame.isPlaying, false);

  const easyChallengeResponse = await handle(request("/api/game/table/start", "POST", {
    ...playerHeaders,
    "content-type": "application/json",
  }, JSON.stringify({ table: 1 })), context);
  challengeGame = await easyChallengeResponse.json();
  for (let index = 0; index < 12; index++) {
    const current = challengeGame.tableChallenge;
    const response = await handle(request("/api/game/table/answer", "POST", {
      ...playerHeaders,
      "content-type": "application/json",
    }, JSON.stringify({ questionId: current.questionId, answer: current.factor })), context);
    tableResult = await response.json();
    challengeGame = tableResult.game;
  }
  assert.equal(tableResult.complete, true);
  assert.equal(tableResult.earnedPoints, 1);
  assert.equal(challengeGame.points, tablePointsBefore + 11);

  const secondEasyChallengeResponse = await handle(request("/api/game/table/start", "POST", {
    ...playerHeaders,
    "content-type": "application/json",
  }, JSON.stringify({ table: 2 })), context);
  challengeGame = await secondEasyChallengeResponse.json();
  for (let index = 0; index < 12; index++) {
    const current = challengeGame.tableChallenge;
    const response = await handle(request("/api/game/table/answer", "POST", {
      ...playerHeaders,
      "content-type": "application/json",
    }, JSON.stringify({ questionId: current.questionId, answer: 2 * current.factor })), context);
    tableResult = await response.json();
    challengeGame = tableResult.game;
  }
  assert.equal(tableResult.complete, true);
  assert.equal(tableResult.earnedPoints, 1);
  assert.equal(challengeGame.points, tablePointsBefore + 12);

  const expiringChallenge = await handle(request("/api/game/table/start", "POST", {
    ...playerHeaders,
    "content-type": "application/json",
  }, JSON.stringify({ table: 12 })), context);
  const expiringGame = await expiringChallenge.json();
  try {
    Date.now = () => expiringGame.tableChallenge.startedAt + 60_000;
    const expiredAnswer = await handle(request("/api/game/table/answer", "POST", {
      ...playerHeaders,
      "content-type": "application/json",
    }, JSON.stringify({
      questionId: expiringGame.tableChallenge.questionId,
      answer: 12 * expiringGame.tableChallenge.factor,
    })), context);
    const expiredResult = await expiredAnswer.json();
    assert.equal(expiredResult.expired, true);
    assert.equal(expiredResult.complete, false);
    assert.equal(expiredResult.game.points, expiringGame.points);
    assert.equal(expiredResult.game.isPlaying, false);
  } finally {
    Date.now = originalNow;
  }
});
