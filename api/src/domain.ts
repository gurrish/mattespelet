import { z } from "zod";

export const rewardInputSchema = z.object({
  name: z.string().trim().min(1).max(48),
  cost: z.number().int().min(1).max(5000),
  active: z.boolean().default(true),
}).strict();

export const operationSchema = z.enum(["multiply", "add", "subtract", "divide"]);
export const operationsSchema = z.array(operationSchema).min(1).max(4)
  .refine((operations) => new Set(operations).size === operations.length);

export const operationsInputSchema = z.object({ operations: operationsSchema }).strict();
export const gameStartSchema = z.object({ operations: operationsSchema }).strict();
export const playerInputSchema = z.object({
  email: z.string().trim().email().max(254).transform((email) => email.toLowerCase()),
}).strict();

export const answerInputSchema = z.object({
  questionId: z.string().uuid(),
  answer: z.number().int().min(0).max(144),
  remainder: z.number().int().min(0).max(11).optional(),
}).strict();

export const tableStartSchema = z.object({
  table: z.number().int().min(1).max(10),
}).strict();

export const forfeitInputSchema = z.object({
  penalize: z.boolean().default(true),
}).strict();

export type GameQuestion = {
  id: string;
  left: number;
  right: number;
  points: number;
  operation: Operation;
};

export type TableChallenge = {
  table: number;
  startedAt: number;
  factors: number[];
  index: number;
  questionId: string;
};

export type PlayerState = {
  email: string;
  points: number;
  correctAnswers: number;
  answeredQuestions: number;
  activeGameId: string | null;
  activeOperations: Operation[];
  question: GameQuestion | null;
  tableChallenge: TableChallenge | null;
  redemptions: Redemption[];
};

export type Reward = {
  id: string;
  name: string;
  cost: number;
  active: boolean;
  updatedAt: string;
};

export type RewardInput = z.infer<typeof rewardInputSchema>;
export type Operation = z.infer<typeof operationSchema>;

export type PlayerAccess = {
  email: string;
  allowed: boolean;
};

export type Redemption = {
  id: string;
  email: string;
  rewardName: string;
  cost: number;
  redeemedAt: string;
};

export function newPlayer(email: string): PlayerState {
  return {
    email,
    points: 0,
    correctAnswers: 0,
    answeredQuestions: 0,
    activeGameId: null,
    activeOperations: ["multiply"],
    question: null,
    tableChallenge: null,
    redemptions: [],
  };
}

export class PlayerConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlayerConflictError";
  }
}
