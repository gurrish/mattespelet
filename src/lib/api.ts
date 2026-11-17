import type { AnswerResult, GameState, Operation, Redemption, Reward, RewardInput, Viewer } from "../types";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (import.meta.env.DEV) {
    const email = localStorage.getItem("mattespelet-dev-email");
    if (email) headers.set("x-dev-user-email", email);
  }
  const response = await fetch(path, { ...init, headers });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(payload?.error || `Något gick fel (felkod ${response.status}).`);
  }
  return response.json() as Promise<T>;
}

export const getViewer = () => request<Viewer>("/api/me");
export const getGame = () => request<GameState>("/api/game");
export const startGame = (operations: Operation[]) =>
  request<GameState>("/api/game/start", { method: "POST", body: JSON.stringify({ operations }) });
export const startTableChallenge = (table: number) =>
  request<GameState>("/api/game/table/start", { method: "POST", body: JSON.stringify({ table }) });
export const nextQuestion = () => request<GameState>("/api/game/next", { method: "POST" });
export const submitAnswer = (questionId: string, answer: number, remainder?: number) =>
  request<AnswerResult>("/api/game/answer", {
    method: "POST",
    body: JSON.stringify({ questionId, answer, ...(remainder === undefined ? {} : { remainder }) }),
  });
export const submitTableAnswer = (questionId: string, answer: number) =>
  request<{
    game: GameState;
    correct: boolean;
    correctAnswer: number;
    complete: boolean;
    expired: boolean;
    earnedPoints: number;
  }>(
    "/api/game/table/answer", { method: "POST", body: JSON.stringify({ questionId, answer }) },
  );
export const forfeitGame = (keepalive = false, penalize = true) =>
  request<{ game: GameState; penalty: number }>("/api/game/forfeit", {
    method: "POST",
    keepalive,
    body: JSON.stringify({ penalize }),
  });
export const getRewards = () => request<Reward[]>("/api/rewards");
export const createReward = (reward: RewardInput) =>
  request<Reward>("/api/rewards", { method: "POST", body: JSON.stringify(reward) });
export const updateReward = (id: string, reward: RewardInput) =>
  request<Reward>(`/api/rewards/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(reward) });
export const deleteReward = (id: string) =>
  request<{ ok: true }>(`/api/rewards/${encodeURIComponent(id)}`, { method: "DELETE" });
export const redeemReward = (id: string) =>
  request<{ points: number; redemption: Redemption }>(`/api/rewards/${encodeURIComponent(id)}/redeem`, { method: "POST" });
export const getRedemptions = () => request<Redemption[]>("/api/redemptions");
export const getPlayers = () => request<string[]>("/api/players");
export const addPlayer = (email: string) =>
  request<{ email: string }>("/api/players", { method: "POST", body: JSON.stringify({ email }) });
export const removePlayer = (email: string) =>
  request<{ ok: true }>(`/api/players/${encodeURIComponent(email)}`, { method: "DELETE" });
export const getEnabledOperations = () => request<Operation[]>("/api/settings/operations");
export const saveEnabledOperations = (operations: Operation[]) =>
  request<Operation[]>("/api/settings/operations", { method: "PUT", body: JSON.stringify({ operations }) });
