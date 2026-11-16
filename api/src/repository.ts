import { TableClient, type TableEntity } from "@azure/data-tables";
import { PlayerConflictError, newPlayer, rewardInputSchema, type PlayerState, type Redemption, type Reward, type RewardInput } from "./domain.js";

export interface Repository {
  getPlayer(id: string, email: string): Promise<PlayerState>;
  updatePlayer(id: string, email: string, update: (player: PlayerState) => PlayerState): Promise<PlayerState>;
  listRewards(): Promise<Reward[]>;
  getReward(id: string): Promise<Reward | undefined>;
  saveReward(reward: Reward): Promise<void>;
  deleteReward(id: string): Promise<void>;
  listRedemptions(): Promise<Redemption[]>;
}

type StoredEntity = TableEntity<Record<string, unknown>>;

function isStatus(error: unknown, statusCode: number): boolean {
  return error instanceof Error && "statusCode" in error && error.statusCode === statusCode;
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

function rewardFromEntity(entity: StoredEntity): Reward {
  if (typeof entity.rowKey !== "string" || typeof entity.updatedAt !== "string") {
    throw new Error("Stored reward has an invalid shape.");
  }
  const parsed = rewardInputSchema.parse({
    name: entity.name,
    cost: entity.cost,
    active: entity.active,
  });
  return { ...parsed, id: entity.rowKey, updatedAt: entity.updatedAt };
}

function playerFromEntity(entity: StoredEntity): PlayerState {
  if (typeof entity.email !== "string" || typeof entity.points !== "number"
    || typeof entity.correctAnswers !== "number" || typeof entity.answeredQuestions !== "number"
    || typeof entity.redemptions !== "string") {
    throw new Error("Stored player has an invalid shape.");
  }
  const activeGameId = typeof entity.activeGameId === "string" && entity.activeGameId ? entity.activeGameId : null;
  const question = typeof entity.question === "string" && entity.question
    ? JSON.parse(entity.question) as PlayerState["question"]
    : null;
  return {
    email: entity.email,
    points: entity.points,
    correctAnswers: entity.correctAnswers,
    answeredQuestions: entity.answeredQuestions,
    activeGameId,
    question,
    tableChallenge: typeof entity.tableChallenge === "string" && entity.tableChallenge
      ? JSON.parse(entity.tableChallenge) as PlayerState["tableChallenge"]
      : null,
    redemptions: JSON.parse(entity.redemptions) as Redemption[],
  };
}

function playerEntity(id: string, player: PlayerState): TableEntity<Record<string, unknown>> {
  return {
    partitionKey: "players",
    rowKey: id,
    email: player.email,
    points: player.points,
    correctAnswers: player.correctAnswers,
    answeredQuestions: player.answeredQuestions,
    activeGameId: player.activeGameId ?? "",
    question: player.question ? JSON.stringify(player.question) : "",
    tableChallenge: player.tableChallenge ? JSON.stringify(player.tableChallenge) : "",
    redemptions: JSON.stringify(player.redemptions),
  };
}

export class MemoryRepository implements Repository {
  private readonly players = new Map<string, PlayerState>();
  private readonly rewards = new Map<string, Reward>();

  async getPlayer(id: string, email: string): Promise<PlayerState> {
    const player = this.players.get(id) ?? newPlayer(email);
    return copy({ ...player, email });
  }

  async updatePlayer(id: string, email: string, update: (player: PlayerState) => PlayerState): Promise<PlayerState> {
    const current = this.players.get(id) ?? newPlayer(email);
    const updated = update(copy({ ...current, email }));
    this.players.set(id, copy(updated));
    return copy(updated);
  }

  async listRewards(): Promise<Reward[]> {
    return [...this.rewards.values()].map(copy);
  }

  async getReward(id: string): Promise<Reward | undefined> {
    const reward = this.rewards.get(id);
    return reward ? copy(reward) : undefined;
  }

  async saveReward(reward: Reward): Promise<void> {
    this.rewards.set(reward.id, copy(reward));
  }

  async deleteReward(id: string): Promise<void> {
    this.rewards.delete(id);
  }

  async listRedemptions(): Promise<Redemption[]> {
    return [...this.players.values()].flatMap((player) => copy(player.redemptions));
  }
}

export class TableRepository implements Repository {
  private readonly players: TableClient;
  private readonly rewards: TableClient;

  constructor(connectionString: string) {
    this.players = TableClient.fromConnectionString(connectionString, "GamePlayers");
    this.rewards = TableClient.fromConnectionString(connectionString, "GameRewards");
  }

  private async ensureTable(table: TableClient): Promise<void> {
    try {
      await table.createTable();
    } catch (error) {
      if (!isStatus(error, 409)) throw error;
    }
  }

  async getPlayer(id: string, email: string): Promise<PlayerState> {
    try {
      return { ...playerFromEntity(await this.players.getEntity<StoredEntity>("players", id)), email };
    } catch (error) {
      if (isStatus(error, 404)) return newPlayer(email);
      throw error;
    }
  }

  async updatePlayer(id: string, email: string, update: (player: PlayerState) => PlayerState): Promise<PlayerState> {
    await this.ensureTable(this.players);
    let existing: StoredEntity | undefined;
    try {
      existing = await this.players.getEntity<StoredEntity>("players", id);
    } catch (error) {
      if (!isStatus(error, 404)) throw error;
    }

    const current = existing ? { ...playerFromEntity(existing), email } : newPlayer(email);
    const updated = update(current);
    const entity = playerEntity(id, updated);
    try {
      if (existing) {
        const etag = existing.etag;
        if (typeof etag !== "string") throw new Error("Stored player entity has no valid ETag.");
        await this.players.updateEntity(entity, "Replace", { etag });
      } else {
        await this.players.createEntity(entity);
      }
    } catch (error) {
      if (isStatus(error, 409) || isStatus(error, 412)) {
        throw new PlayerConflictError("Spelkontot uppdaterades samtidigt. Försök igen.");
      }
      throw error;
    }
    return updated;
  }

  async listRewards(): Promise<Reward[]> {
    await this.ensureTable(this.rewards);
    const result: Reward[] = [];
    for await (const entity of this.rewards.listEntities<StoredEntity>()) result.push(rewardFromEntity(entity));
    return result;
  }

  async getReward(id: string): Promise<Reward | undefined> {
    try {
      return rewardFromEntity(await this.rewards.getEntity<StoredEntity>("rewards", id));
    } catch (error) {
      if (isStatus(error, 404)) return undefined;
      throw error;
    }
  }

  async saveReward(reward: Reward): Promise<void> {
    await this.ensureTable(this.rewards);
    const { id, ...fields } = reward;
    await this.rewards.upsertEntity({ partitionKey: "rewards", rowKey: id, ...fields }, "Replace");
  }

  async deleteReward(id: string): Promise<void> {
    try {
      await this.rewards.deleteEntity("rewards", id);
    } catch (error) {
      if (!isStatus(error, 404)) throw error;
    }
  }

  async listRedemptions(): Promise<Redemption[]> {
    await this.ensureTable(this.players);
    const result: Redemption[] = [];
    for await (const entity of this.players.listEntities<StoredEntity>()) {
      result.push(...playerFromEntity(entity).redemptions);
    }
    return result;
  }
}

let repository: Repository | undefined;
export function getRepository(): Repository {
  if (repository) return repository;
  const mode = process.env.STORAGE_MODE ?? (process.env.NODE_ENV === "development" ? "memory" : "table");
  if (mode === "memory") repository = new MemoryRepository();
  else if (mode === "table" && process.env.STORAGE_CONNECTION_STRING) {
    repository = new TableRepository(process.env.STORAGE_CONNECTION_STRING);
  } else {
    throw new Error("Configure STORAGE_CONNECTION_STRING with STORAGE_MODE=table, or use STORAGE_MODE=memory locally.");
  }
  return repository;
}

export function createReward(id: string, input: RewardInput): Reward {
  return { ...input, id, updatedAt: new Date().toISOString() };
}
