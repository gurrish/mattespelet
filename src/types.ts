export interface Viewer {
  signedIn: boolean;
  email: string | null;
  isAdmin: boolean;
  isPlayer: boolean;
}

export interface GameQuestion {
  id: string;
  left: number;
  right: number;
  points: number;
}

export interface GameState {
  points: number;
  correctAnswers: number;
  answeredQuestions: number;
  isPlaying: boolean;
  question: GameQuestion | null;
  tableChallenge: TableChallenge | null;
}

export interface TableChallenge {
  table: number;
  startedAt: number;
  index: number;
  questionId: string;
  factor: number;
}

export interface Reward {
  id: string;
  name: string;
  cost: number;
  active: boolean;
  updatedAt: string;
}

export interface RewardInput {
  name: string;
  cost: number;
  active: boolean;
}

export interface Redemption {
  id: string;
  email: string;
  rewardName: string;
  cost: number;
  redeemedAt: string;
}

export interface AnswerResult {
  game: GameState;
  correct: boolean;
  correctAnswer: number;
  earnedPoints: number;
}
