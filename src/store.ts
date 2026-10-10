import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "./is.js";
import { shanghaiParts } from "./time.js";

export interface AuditEvent {
  at: string;
  tool: string;
  decision: "allow" | "hold" | "deny" | "forward" | "forward-failed";
  pendingId?: string;
  amountCents?: number;
  note?: string;
}

export interface PendingAction {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  createdAt: string;
  expiresAt: string;
  status: "pending" | "confirming" | "done" | "denied";
  quoteCents: number | null;
  confirmingAt?: string;
  resultText?: string;
  orderId?: string;
}

export interface PlanState {
  preparedAt: string;
  headline: string;
  hint: string;
  quiet: boolean;
  quoteCents: number | null;
  label: string | null;
  pendingId: string | null;
  note: string;
  clock: string | null;
  resetAtMs: number | null;
}

export interface PickupState {
  orderId: string;
  status: string;
  code: string | null;
  updatedAt: string;
  terminal: boolean;
}

export interface QuotaWindowState {
  key: string;
  label: string;
  usedPercentage: number;
  resetsAtMs: number | null;
}

export interface QuotaSnapshot {
  savedAt: string;
  windows: QuotaWindowState[];
  durationMs: number | null;
}

export interface HookNotice {
  at: string;
  signature: string;
}

export type MealSlotId = "lunch" | "dinner";

export interface MealRecord {
  ymd: string;
  slot: MealSlotId;
  nudged: boolean;
  dismissed: "ate" | "skip" | null;
  snoozeUntil: string | null;
  ordered: boolean;
  prepMinutes: number | null;
  prepSource: "mcp" | "default" | null;
  quoteCents: number | null;
  pendingId: string | null;
  label: string | null;
  preparedAt: string | null;
  note: string | null;
}

export interface MealsFile {
  learnedPrepMinutes: number | null;
  records: MealRecord[];
}

export class HomeStore {
  constructor(readonly root: string) {}

  ensure(): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    mkdirSync(this.pendingDir(), { recursive: true, mode: 0o700 });
  }

  pendingDir(): string {
    return join(this.root, "pending");
  }

  appendAudit(event: AuditEvent): void {
    this.ensure();
    writeFileSync(this.auditPath(), `${JSON.stringify(event)}\n`, { flag: "a", mode: 0o600 });
  }

  readAudit(): AuditEvent[] {
    const file = this.auditPath();
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line) as unknown;
          return isAudit(parsed) ? [parsed] : [];
        } catch {
          return [];
        }
      });
  }

  spentTodayCents(now: Date): number {
    const ymd = shanghaiParts(now).ymd;
    return this.readAudit()
      .filter((event) => event.decision === "forward" && event.tool === "create-order" && event.amountCents != null)
      .filter((event) => shanghaiParts(new Date(event.at)).ymd === ymd)
      .reduce((sum, event) => sum + (event.amountCents ?? 0), 0);
  }

  unpricedForwardsToday(now: Date): number {
    const ymd = shanghaiParts(now).ymd;
    return this.readAudit().filter((event) => {
      if (event.decision !== "forward" || event.tool === "create-order") return false;
      return shanghaiParts(new Date(event.at)).ymd === ymd;
    }).length;
  }

  createPending(input: {
    tool: string;
    args: Record<string, unknown>;
    quoteCents: number | null;
    now: Date;
    ttlMinutes: number;
  }): PendingAction {
    this.ensure();
    const pending: PendingAction = {
      id: this.allocId(),
      tool: input.tool,
      args: input.args,
      createdAt: input.now.toISOString(),
      expiresAt: new Date(input.now.getTime() + input.ttlMinutes * 60_000).toISOString(),
      status: "pending",
      quoteCents: input.quoteCents,
    };
    this.writePending(pending);
    return pending;
  }

  writePending(pending: PendingAction): void {
    this.ensure();
    const file = this.pendingPath(pending.id);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(pending, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  }

  readPending(id: string): PendingAction | null {
    if (!/^[a-f0-9]{8}$/.test(id)) return null;
    const file = this.pendingPath(id);
    if (!existsSync(file)) return null;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
      return isPending(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  listPending(): PendingAction[] {
    this.ensure();
    return readdirSync(this.pendingDir())
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -5))
      .flatMap((id) => {
        const pending = this.readPending(id);
        return pending ? [pending] : [];
      })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  readPlan(): PlanState | null {
    return readJson(this.planPath(), isPlan);
  }

  writePlan(plan: PlanState): void {
    this.writeJson(this.planPath(), plan);
  }

  readPickup(): PickupState | null {
    return readJson(this.pickupPath(), isPickup);
  }

  writePickup(pickup: PickupState): void {
    this.writeJson(this.pickupPath(), pickup);
  }

  readQuota(): QuotaSnapshot | null {
    return readJson(this.quotaPath(), isQuota);
  }

  writeQuota(snapshot: QuotaSnapshot): void {
    this.writeJson(this.quotaPath(), snapshot);
  }

  readHookNotice(): HookNotice | null {
    return readJson(this.hookPath(), isHook);
  }

  writeHookNotice(notice: HookNotice): void {
    this.writeJson(this.hookPath(), notice);
  }

  readMeals(): MealsFile {
    const parsed = readJson(this.mealsPath(), isMealsFile);
    if (!parsed) return { learnedPrepMinutes: null, records: [] };
    return {
      learnedPrepMinutes:
        typeof parsed.learnedPrepMinutes === "number" && parsed.learnedPrepMinutes >= 1 && parsed.learnedPrepMinutes <= 180
          ? Math.trunc(parsed.learnedPrepMinutes)
          : null,
      records: parsed.records.flatMap((record) => {
        const meal = normalizeMeal(record);
        return meal ? [meal] : [];
      }),
    };
  }

  readMeal(ymd: string, slot: MealSlotId): MealRecord | null {
    return this.readMeals().records.find((record) => record.ymd === ymd && record.slot === slot) ?? null;
  }

  writeMeal(record: MealRecord): void {
    const file = this.readMeals();
    const meal = normalizeMeal(record);
    if (!meal) return;
    const records = file.records.filter((item) => !(item.ymd === meal.ymd && item.slot === meal.slot));
    records.push(meal);
    records.sort((a, b) => `${a.ymd}${a.slot}`.localeCompare(`${b.ymd}${b.slot}`));
    this.writeJson(this.mealsPath(), { learnedPrepMinutes: file.learnedPrepMinutes, records: records.slice(-32) });
  }

  readLearnedPrep(): number | null {
    return this.readMeals().learnedPrepMinutes;
  }

  writeLearnedPrep(minutes: number): void {
    const file = this.readMeals();
    this.writeJson(this.mealsPath(), { ...file, learnedPrepMinutes: Math.trunc(minutes) });
  }

  private allocId(): string {
    for (let i = 0; i < 5; i += 1) {
      const id = randomBytes(4).toString("hex");
      if (!existsSync(this.pendingPath(id))) return id;
    }
    return randomBytes(4).toString("hex");
  }

  private writeJson(file: string, value: unknown): void {
    this.ensure();
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  }

  private auditPath(): string {
    return join(this.root, "audit.jsonl");
  }

  private pendingPath(id: string): string {
    return join(this.pendingDir(), `${id}.json`);
  }

  private planPath(): string {
    return join(this.root, "plan.json");
  }

  private pickupPath(): string {
    return join(this.root, "pickup.json");
  }

  private quotaPath(): string {
    return join(this.root, "quota.json");
  }

  private hookPath(): string {
    return join(this.root, "hook-notice.json");
  }

  private mealsPath(): string {
    return join(this.root, "meals.json");
  }
}

function readJson<T>(file: string, guard: (value: unknown) => value is T): T | null {
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return guard(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isAudit(value: unknown): value is AuditEvent {
  return isRecord(value) && typeof value.at === "string" && typeof value.tool === "string" && typeof value.decision === "string";
}

function isPending(value: unknown): value is PendingAction {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.tool === "string" &&
    isRecord(value.args) &&
    typeof value.createdAt === "string" &&
    typeof value.expiresAt === "string" &&
    typeof value.status === "string"
  );
}

function isPlan(value: unknown): value is PlanState {
  return isRecord(value) && typeof value.preparedAt === "string" && typeof value.headline === "string";
}

function isPickup(value: unknown): value is PickupState {
  return isRecord(value) && typeof value.orderId === "string" && typeof value.status === "string";
}

function isQuota(value: unknown): value is QuotaSnapshot {
  return isRecord(value) && typeof value.savedAt === "string" && Array.isArray(value.windows);
}

function isHook(value: unknown): value is HookNotice {
  return isRecord(value) && typeof value.at === "string" && typeof value.signature === "string";
}

function isMealsFile(value: unknown): value is MealsFile {
  return isRecord(value) && Array.isArray(value.records);
}

function normalizeMeal(value: unknown): MealRecord | null {
  if (!isRecord(value) || typeof value.ymd !== "string") return null;
  if (value.slot !== "lunch" && value.slot !== "dinner") return null;
  return {
    ymd: value.ymd,
    slot: value.slot,
    nudged: value.nudged === true,
    dismissed: value.dismissed === "ate" || value.dismissed === "skip" ? value.dismissed : null,
    snoozeUntil: typeof value.snoozeUntil === "string" ? value.snoozeUntil : null,
    ordered: value.ordered === true,
    prepMinutes: typeof value.prepMinutes === "number" ? value.prepMinutes : null,
    prepSource: value.prepSource === "mcp" || value.prepSource === "default" ? value.prepSource : null,
    quoteCents: typeof value.quoteCents === "number" ? value.quoteCents : null,
    pendingId: typeof value.pendingId === "string" ? value.pendingId : null,
    label: typeof value.label === "string" ? value.label : null,
    preparedAt: typeof value.preparedAt === "string" ? value.preparedAt : null,
    note: typeof value.note === "string" ? value.note : null,
  };
}
