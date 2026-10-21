import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isRecord } from "./is.js";
import { beCodeRequired } from "./money.js";
import { formatHm, isValidTimeZone, parseHm } from "./time.js";
import { UserError } from "./user-error.js";
export function defaultMeals() {
    return {
        enabled: false,
        timezone: "Asia/Shanghai",
        weekends: false,
        lunch: "12:00",
        dinner: "18:30",
        prepMinutes: 20,
        lingerMinutes: 45,
        notify: false,
    };
}
export function defaultConfig() {
    return {
        upstreamUrl: "https://mcp.mcd.cn",
        maxOrderCny: 80,
        dailyLimitCny: 150,
        maxItemQuantity: 12,
        maxUnpricedWrites: 8,
        pendingTtlMinutes: 480,
        quietStartHour: 23,
        quietEndHour: 6,
        quotaThreshold: 90,
        prepMinutes: 20,
        longSessionMinutes: 90,
        meals: defaultMeals(),
    };
}
export function resolveHome(env) {
    const raw = env.MCD_HOME?.trim();
    if (raw)
        return resolve(raw);
    return join(homedir(), ".mcd-cooldown");
}
export function loadConfig(home, env) {
    const config = defaultConfig();
    const warnings = [];
    const file = join(home, "config.json");
    if (existsSync(file)) {
        let parsed;
        try {
            parsed = JSON.parse(readFileSync(file, "utf8"));
        }
        catch {
            throw new UserError(`无法解析 ${file}`);
        }
        if (!isRecord(parsed))
            throw new UserError(`${file} 必须是 JSON 对象`);
        if ("token" in parsed || "mcpToken" in parsed || "authorization" in parsed || "MCD_MCP_TOKEN" in parsed) {
            warnings.push("配置文件里有 Token 字段，已忽略。Token 请放在环境变量 MCD_MCP_TOKEN 或本机 token 文件。");
        }
        assignConfig(config, parsed);
    }
    if (env.MCD_MCP_URL?.trim())
        config.upstreamUrl = env.MCD_MCP_URL.trim();
    overrideNumber(env.MCD_MAX_ORDER_CNY, (value) => {
        config.maxOrderCny = value;
    });
    overrideNumber(env.MCD_DAILY_LIMIT_CNY, (value) => {
        config.dailyLimitCny = value;
    });
    overrideNumber(env.MCD_MAX_ITEM_QUANTITY, (value) => {
        config.maxItemQuantity = value;
    });
    overrideNumber(env.MCD_MAX_UNPRICED_WRITES, (value) => {
        config.maxUnpricedWrites = value;
    });
    overrideNumber(env.MCD_QUOTA_THRESHOLD, (value) => {
        config.quotaThreshold = value;
    });
    overrideNumber(env.MCD_QUIET_START, (value) => {
        config.quietStartHour = value;
    });
    overrideNumber(env.MCD_QUIET_END, (value) => {
        config.quietEndHour = value;
    });
    overrideNumber(env.MCD_PREP_MINUTES, (value) => {
        config.prepMinutes = value;
    });
    return { config, warnings };
}
function assignConfig(config, raw) {
    const num = (key) => {
        const value = raw[key];
        if (typeof value === "number" && Number.isFinite(value)) {
            config[key] = value;
        }
    };
    num("maxOrderCny");
    num("dailyLimitCny");
    num("maxItemQuantity");
    num("maxUnpricedWrites");
    num("pendingTtlMinutes");
    num("quietStartHour");
    num("quietEndHour");
    num("quotaThreshold");
    num("prepMinutes");
    num("longSessionMinutes");
    if (typeof raw.upstreamUrl === "string" && raw.upstreamUrl.trim()) {
        config.upstreamUrl = raw.upstreamUrl.trim();
    }
    if (isRecord(raw.store))
        config.store = readStore(raw.store);
    if (isRecord(raw.usual))
        config.usual = readUsual(raw.usual);
    if (isRecord(raw.meals))
        assignMeals(config.meals, raw.meals);
}
function assignMeals(meals, raw) {
    if (typeof raw.enabled === "boolean")
        meals.enabled = raw.enabled;
    if (typeof raw.weekends === "boolean")
        meals.weekends = raw.weekends;
    if (typeof raw.notify === "boolean")
        meals.notify = raw.notify;
    if (typeof raw.timezone === "string" && isValidTimeZone(raw.timezone.trim()))
        meals.timezone = raw.timezone.trim();
    if (typeof raw.prepMinutes === "number" && raw.prepMinutes >= 1 && raw.prepMinutes <= 180)
        meals.prepMinutes = Math.trunc(raw.prepMinutes);
    if (typeof raw.lingerMinutes === "number" && raw.lingerMinutes >= 0 && raw.lingerMinutes <= 180) {
        meals.lingerMinutes = Math.trunc(raw.lingerMinutes);
    }
    const lunch = clockField(raw.lunch);
    const dinner = clockField(raw.dinner);
    if (lunch)
        meals.lunch = lunch;
    if (dinner)
        meals.dinner = dinner;
}
function clockField(value) {
    if (typeof value !== "string")
        return null;
    const parsed = parseHm(value);
    if (!parsed)
        return null;
    return formatHm(parsed.hour, parsed.minute);
}
function readStore(raw) {
    const storeCode = stringField(raw.storeCode);
    const beCode = stringField(raw.beCode);
    const beType = typeof raw.beType === "number" ? raw.beType : 1;
    const orderType = typeof raw.orderType === "number" ? raw.orderType : beType === 2 || beType === 6 ? 2 : 1;
    if (!storeCode)
        return undefined;
    if (beCodeRequired(beType) && !beCode)
        return undefined;
    const store = { storeCode, beType, orderType };
    if (beCode)
        store.beCode = beCode;
    const takeWayCode = stringField(raw.takeWayCode);
    const addressId = stringField(raw.addressId);
    const gmServiceCode = stringField(raw.gmServiceCode);
    if (takeWayCode)
        store.takeWayCode = takeWayCode;
    if (addressId)
        store.addressId = addressId;
    if (gmServiceCode)
        store.gmServiceCode = gmServiceCode;
    return store;
}
function readUsual(raw) {
    if (!Array.isArray(raw.items))
        return undefined;
    const items = raw.items.flatMap((item) => {
        if (!isRecord(item))
            return [];
        const productCode = stringField(item.productCode);
        const quantity = typeof item.quantity === "number" ? item.quantity : 1;
        if (!productCode || quantity <= 0)
            return [];
        return [{ productCode, quantity }];
    });
    if (items.length === 0)
        return undefined;
    return { label: stringField(raw.label) ?? "常点一份", items };
}
function stringField(value) {
    if (typeof value !== "string")
        return undefined;
    const trimmed = value.trim();
    return trimmed || undefined;
}
function overrideNumber(raw, apply) {
    if (!raw?.trim())
        return;
    const value = Number(raw);
    if (!Number.isFinite(value))
        return;
    apply(value);
}
export function placeholderConfig(config) {
    const beCode = config.store && beCodeRequired(config.store.beType) ? config.store.beCode : undefined;
    const values = [
        config.store?.storeCode,
        beCode,
        config.store?.takeWayCode,
        ...(config.usual?.items.map((item) => item.productCode) ?? []),
    ];
    return values.some((value) => value != null && (value.startsWith("YOUR_") || value.includes("替换")));
}
/** Store and usual meal are filled in with real codes, so the status line can say it is ready. */
export function readyConfig(config) {
    if (placeholderConfig(config))
        return false;
    if (!config.store?.storeCode?.trim())
        return false;
    if (!config.usual || config.usual.items.length === 0)
        return false;
    return true;
}
export function assertHomeOutside(home, workspace) {
    const root = resolve(workspace);
    const target = resolve(home);
    if (root === resolve(homedir()))
        return;
    if (!isGitCheckout(root))
        return;
    if (target === root || target.startsWith(`${root}/`)) {
        throw new UserError("MCD_HOME 不能放在项目目录里，避免 Token 和订单记录被提交");
    }
}
function isGitCheckout(start) {
    let current = resolve(start);
    for (;;) {
        if (existsSync(join(current, ".git")))
            return true;
        const parent = dirname(current);
        if (parent === current)
            return false;
        current = parent;
    }
}
export function modifyConfig(home, change) {
    const { config } = loadConfig(home, {});
    change(config);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    writeFileSync(join(home, "config.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    return config;
}
export function filledConfigText(input) {
    const meals = defaultMeals();
    meals.enabled = input.mealsEnabled === true;
    return `${JSON.stringify({
        ...defaultConfig(),
        meals,
        store: input.store,
        usual: input.usual,
    }, null, 2)}\n`;
}
export function exampleConfigText(mealsEnabled = false) {
    return filledConfigText({
        mealsEnabled,
        store: {
            storeCode: "YOUR_STORE_CODE",
            beType: 1,
            orderType: 1,
            takeWayCode: "eat-in",
        },
        usual: {
            label: "常点一份",
            items: [{ productCode: "YOUR_PRODUCT_CODE", quantity: 1 }],
        },
    });
}
//# sourceMappingURL=config.js.map