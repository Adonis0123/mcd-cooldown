import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "./is.js";
import { shanghaiParts } from "./time.js";
export class HomeStore {
    root;
    constructor(root) {
        this.root = root;
    }
    ensure() {
        mkdirSync(this.root, { recursive: true, mode: 0o700 });
        mkdirSync(this.pendingDir(), { recursive: true, mode: 0o700 });
    }
    pendingDir() {
        return join(this.root, "pending");
    }
    appendAudit(event) {
        this.ensure();
        writeFileSync(this.auditPath(), `${JSON.stringify(event)}\n`, { flag: "a", mode: 0o600 });
    }
    readAudit() {
        const file = this.auditPath();
        if (!existsSync(file))
            return [];
        return readFileSync(file, "utf8")
            .split("\n")
            .filter((line) => line.trim())
            .flatMap((line) => {
            try {
                const parsed = JSON.parse(line);
                return isAudit(parsed) ? [parsed] : [];
            }
            catch {
                return [];
            }
        });
    }
    spentTodayCents(now) {
        const ymd = shanghaiParts(now).ymd;
        return this.readAudit()
            .filter((event) => event.decision === "forward" && event.tool === "create-order" && event.amountCents != null)
            .filter((event) => shanghaiParts(new Date(event.at)).ymd === ymd)
            .reduce((sum, event) => sum + (event.amountCents ?? 0), 0);
    }
    unpricedForwardsToday(now) {
        const ymd = shanghaiParts(now).ymd;
        return this.readAudit().filter((event) => {
            if (event.decision !== "forward" || event.tool === "create-order")
                return false;
            return shanghaiParts(new Date(event.at)).ymd === ymd;
        }).length;
    }
    createPending(input) {
        this.ensure();
        const pending = {
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
    writePending(pending) {
        this.ensure();
        const file = this.pendingPath(pending.id);
        const tmp = `${file}.tmp`;
        writeFileSync(tmp, `${JSON.stringify(pending, null, 2)}\n`, { mode: 0o600 });
        renameSync(tmp, file);
    }
    readPending(id) {
        if (!/^[a-f0-9]{8}$/.test(id))
            return null;
        const file = this.pendingPath(id);
        if (!existsSync(file))
            return null;
        try {
            const parsed = JSON.parse(readFileSync(file, "utf8"));
            return isPending(parsed) ? parsed : null;
        }
        catch {
            return null;
        }
    }
    listPending() {
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
    readPlan() {
        return readJson(this.planPath(), isPlan);
    }
    writePlan(plan) {
        this.writeJson(this.planPath(), plan);
    }
    readPickup() {
        return readJson(this.pickupPath(), isPickup);
    }
    writePickup(pickup) {
        this.writeJson(this.pickupPath(), pickup);
    }
    readQuota() {
        return readJson(this.quotaPath(), isQuota);
    }
    writeQuota(snapshot) {
        this.writeJson(this.quotaPath(), snapshot);
    }
    readHookNotice() {
        return readJson(this.hookPath(), isHook);
    }
    writeHookNotice(notice) {
        this.writeJson(this.hookPath(), notice);
    }
    readMeals() {
        const parsed = readJson(this.mealsPath(), isMealsFile);
        if (!parsed)
            return { learnedPrepMinutes: null, records: [] };
        return {
            learnedPrepMinutes: typeof parsed.learnedPrepMinutes === "number" && parsed.learnedPrepMinutes >= 1 && parsed.learnedPrepMinutes <= 180
                ? Math.trunc(parsed.learnedPrepMinutes)
                : null,
            records: parsed.records.flatMap((record) => {
                const meal = normalizeMeal(record);
                return meal ? [meal] : [];
            }),
        };
    }
    readMeal(ymd, slot) {
        return this.readMeals().records.find((record) => record.ymd === ymd && record.slot === slot) ?? null;
    }
    writeMeal(record) {
        const file = this.readMeals();
        const meal = normalizeMeal(record);
        if (!meal)
            return;
        const records = file.records.filter((item) => !(item.ymd === meal.ymd && item.slot === meal.slot));
        records.push(meal);
        records.sort((a, b) => `${a.ymd}${a.slot}`.localeCompare(`${b.ymd}${b.slot}`));
        this.writeJson(this.mealsPath(), { learnedPrepMinutes: file.learnedPrepMinutes, records: records.slice(-32) });
    }
    readLearnedPrep() {
        return this.readMeals().learnedPrepMinutes;
    }
    writeLearnedPrep(minutes) {
        const file = this.readMeals();
        this.writeJson(this.mealsPath(), { ...file, learnedPrepMinutes: Math.trunc(minutes) });
    }
    allocId() {
        for (let i = 0; i < 5; i += 1) {
            const id = randomBytes(4).toString("hex");
            if (!existsSync(this.pendingPath(id)))
                return id;
        }
        return randomBytes(4).toString("hex");
    }
    writeJson(file, value) {
        this.ensure();
        const tmp = `${file}.tmp`;
        writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
        renameSync(tmp, file);
    }
    auditPath() {
        return join(this.root, "audit.jsonl");
    }
    pendingPath(id) {
        return join(this.pendingDir(), `${id}.json`);
    }
    planPath() {
        return join(this.root, "plan.json");
    }
    pickupPath() {
        return join(this.root, "pickup.json");
    }
    quotaPath() {
        return join(this.root, "quota.json");
    }
    hookPath() {
        return join(this.root, "hook-notice.json");
    }
    mealsPath() {
        return join(this.root, "meals.json");
    }
}
function readJson(file, guard) {
    if (!existsSync(file))
        return null;
    try {
        const parsed = JSON.parse(readFileSync(file, "utf8"));
        return guard(parsed) ? parsed : null;
    }
    catch {
        return null;
    }
}
function isAudit(value) {
    return isRecord(value) && typeof value.at === "string" && typeof value.tool === "string" && typeof value.decision === "string";
}
function isPending(value) {
    return (isRecord(value) &&
        typeof value.id === "string" &&
        typeof value.tool === "string" &&
        isRecord(value.args) &&
        typeof value.createdAt === "string" &&
        typeof value.expiresAt === "string" &&
        typeof value.status === "string");
}
function isPlan(value) {
    return isRecord(value) && typeof value.preparedAt === "string" && typeof value.headline === "string";
}
function isPickup(value) {
    return isRecord(value) && typeof value.orderId === "string" && typeof value.status === "string";
}
function isQuota(value) {
    return isRecord(value) && typeof value.savedAt === "string" && Array.isArray(value.windows);
}
function isHook(value) {
    return isRecord(value) && typeof value.at === "string" && typeof value.signature === "string";
}
function isMealsFile(value) {
    return isRecord(value) && Array.isArray(value.records);
}
function normalizeMeal(value) {
    if (!isRecord(value) || typeof value.ymd !== "string")
        return null;
    if (value.slot !== "lunch" && value.slot !== "dinner")
        return null;
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
//# sourceMappingURL=store.js.map