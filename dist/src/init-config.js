import { toolEffect } from "./catalog.js";
import { defaultMeals, filledConfigText } from "./config.js";
import { extractStores } from "./doctor.js";
import { asText, isRecord } from "./is.js";
import { businessFailed, MEAL_UNAVAILABLE_HINT, payloadRecord, unwrapPayload } from "./mcp/parse.js";
import { parseHm, zonedInstant, zonedParts } from "./time.js";
import { userCommand } from "./user-command.js";
import { UserError } from "./user-error.js";
const INIT_TOOLS = new Set(["query-nearby-stores", "query-meals"]);
export function assertInitTool(name) {
    if (!INIT_TOOLS.has(name) || toolEffect(name) === "write") {
        throw new UserError(`init 只会查询附近门店和菜单，拒绝调用 ${name}。没有写入配置，也没有下单。`);
    }
}
export function assertConfigHidesToken(text, token) {
    if (token && token.length >= 8 && text.includes(token)) {
        throw new UserError("查询结果里出现了 Token，已拒绝写入配置。没有下单。");
    }
}
export function splitChoices(value) {
    return value
        .split(/[,，、\s]+/)
        .map((part) => part.trim())
        .filter(Boolean);
}
export function pickByToken(list, token, codeOf) {
    const trimmed = token.trim();
    if (!trimmed)
        return undefined;
    const byCode = list.find((item) => codeOf(item) === trimmed);
    if (byCode)
        return byCode;
    if (/^[1-9]\d*$/.test(trimmed)) {
        const index = Number(trimmed);
        if (index >= 1 && index <= list.length)
            return list[index - 1];
    }
    return undefined;
}
export function extractMeals(payload) {
    const root = payloadRecord(payload);
    const meals = isRecord(root.meals) ? root.meals : {};
    const ordered = [];
    const seen = new Set();
    const push = (code, category, fallback) => {
        if (!code || seen.has(code))
            return;
        const fromMap = isRecord(meals[code]) ? meals[code] : fallback;
        seen.add(code);
        ordered.push({
            code,
            name: asText(fromMap?.name) ?? asText(fromMap?.productName) ?? code,
            price: asText(fromMap?.currentPrice) ?? asText(fromMap?.price),
            category,
        });
    };
    const categories = Array.isArray(root.categories) ? root.categories : [];
    for (const category of categories) {
        if (!isRecord(category))
            continue;
        const categoryName = asText(category.name);
        const list = Array.isArray(category.meals) ? category.meals : [];
        for (const meal of list) {
            if (!isRecord(meal))
                continue;
            const code = asText(meal.code) ?? asText(meal.productCode);
            if (code)
                push(code, categoryName, meal);
        }
    }
    for (const [code, entry] of Object.entries(meals)) {
        if (isRecord(entry))
            push(code, null);
    }
    for (const key of ["list", "products", "productList"]) {
        const list = root[key];
        if (!Array.isArray(list))
            continue;
        for (const item of list) {
            if (!isRecord(item))
                continue;
            const code = asText(item.code) ?? asText(item.productCode);
            if (code)
                push(code, asText(item.category), item);
        }
    }
    return ordered;
}
export function formatStoreChoices(stores) {
    return stores
        .map((store, index) => {
        const status = store.businessStatus === true ? "营业中" : store.businessStatus === false ? "未营业" : "营业状态未知";
        const hours = store.businessStartTime && store.businessEndTime ? ` ${store.businessStartTime}-${store.businessEndTime}` : "";
        const address = store.address ? `\n   ${store.address}` : "";
        return `${index + 1}. ${store.storeName}  ${store.storeCode}  ${status}${hours}${address}`;
    })
        .join("\n");
}
/** Live category names can embed newlines, e.g. "鸡肉汉堡\\n/卷". Keep the header on one line. */
export function flattenMenuLabel(value) {
    return value
        .split(/\r?\n/)
        .map((part) => part.replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .join("");
}
export function formatMenuChoices(items) {
    const lines = [];
    let lastCategory = null;
    items.forEach((item, index) => {
        const category = item.category ? flattenMenuLabel(item.category) : "";
        if (category && category !== lastCategory) {
            lines.push(category);
            lastCategory = category;
        }
        const price = item.price ? `  ¥${item.price.replace(/^¥/, "")}` : "";
        lines.push(`${index + 1}. ${item.name}  ${item.code}${price}`);
    });
    return lines.join("\n");
}
/** Picking list stays short. Item numbers stay the full-menu indexes, so `--item 3` still matches. */
export const MENU_PREVIEW_LIMIT = 20;
export function formatMenuListing(items, menuAll = false, interactive = false) {
    const shown = menuAll ? items : items.slice(0, MENU_PREVIEW_LIMIT);
    const body = formatMenuChoices(shown);
    const hint = menuPickHint(shown.length, items.length, interactive && !menuAll);
    return body ? `${body}\n${hint}` : hint;
}
function menuPickHint(shown, total, offerTypedAll) {
    const range = shown < total ? `只列出前 ${shown} 项，共 ${total} 项。` : "";
    const all = offerTypedAll ? "--menu-all 列出全部菜单，或输入 all。" : "--menu-all 列出全部菜单。";
    return `${range}${all}--item <编码> 可重复，写入配置。`;
}
export function formatInitSummary(file, result) {
    const cmd = userCommand();
    const items = result.items.map((item) => `${item.name}（${item.code}）`).join("、");
    const meals = result.mealsEnabled
        ? `饭点提醒已写入配置。周末默认关闭，需要的话再执行 ${cmd} meals weekends on`
        : `写代码时想被提醒吃饭：${cmd} meals on`;
    return [
        `已写入 ${file}`,
        `门店：${result.store.storeName}（${result.store.storeCode}）到店自取`,
        `常点：${items}`,
        `菜单按下一个饭点 ${result.reservationDate} 查询，避开当时段不卖的早餐款。`,
        "只读查询了 query-nearby-stores 和 query-meals。没有下单。",
        "Token 不要写进这个文件。",
        meals,
    ].join("\n");
}
/**
 * Saved lunch/dinner items are not on sale yet. Re-running init would query the
 * same next meal and save the same items.
 */
const READY_BEFORE_MEAL = "门店和常点已经就绪。下一顿饭点提醒前会核价。要再核对门店，可运行 doctor --city 城市 --keyword 关键词。";
export const BREAKFAST_HOUR_HINT = `现在还是早餐时段，保存的正餐还没开卖。饭点提醒会在饭点前核价，不必重新跑 init。${READY_BEFORE_MEAL}`;
/** Before the next configured meal, but not the same-day breakfast gap before lunch. */
export const BEFORE_NEXT_MEAL_HINT = `下一顿午饭或晚饭还没到，保存的正餐还没开卖。饭点提醒会在饭点前核价，不必重新跑 init。${READY_BEFORE_MEAL}`;
/**
 * Next lunch or dinner, strictly after `now`, as `yyyy-MM-dd HH:mm`.
 * Init has no saved config yet, so the clocks default to 12:00 and 18:30.
 * A past reservationDate is rejected by the upstream menu API.
 */
export function nextMealReservationDate(now, timeZone = defaultMeals().timezone, lunch = defaultMeals().lunch, dinner = defaultMeals().dinner) {
    const best = upcomingMeal(now, timeZone, lunch, dinner);
    if (!best)
        throw new UserError("算不出下一个午饭或晚饭时间。没有写入配置，也没有下单。");
    const zoned = zonedParts(best.at, timeZone);
    return `${zoned.ymd} ${zoned.hm}`;
}
/**
 * Wording for upstream 60006. Before the next lunch/dinner, the saved meal is
 * not selling yet, so init should stay. Inside the meal window (prep lead
 * through linger), a 60006 means those items are actually unavailable.
 */
export function unavailableMealHint(now, meals = defaultMeals()) {
    if (inOrNearMealWindow(now, meals))
        return MEAL_UNAVAILABLE_HINT;
    const next = upcomingMeal(now, meals.timezone, meals.lunch, meals.dinner);
    if (next?.slot === "lunch" && zonedParts(now, meals.timezone).ymd === zonedParts(next.at, meals.timezone).ymd) {
        return BREAKFAST_HOUR_HINT;
    }
    return BEFORE_NEXT_MEAL_HINT;
}
/** Next lunch or dinner strictly after `now`, as `午饭 12:00`. Null when the clocks cannot be parsed. */
export function nextMealLabel(now, meals = defaultMeals()) {
    const next = upcomingMeal(now, meals.timezone, meals.lunch, meals.dinner);
    if (!next)
        return null;
    const hm = next.slot === "lunch" ? meals.lunch : meals.dinner;
    return `${next.slot === "lunch" ? "午饭" : "晚饭"} ${hm}`;
}
function upcomingMeal(now, timeZone, lunch, dinner) {
    const parts = zonedParts(now, timeZone);
    let best = null;
    for (let add = 0; add < 3; add += 1) {
        const day = shiftDate(parts.year, parts.month, parts.day, add);
        for (const slot of ["lunch", "dinner"]) {
            const clock = parseHm(slot === "lunch" ? lunch : dinner);
            if (!clock)
                continue;
            const at = zonedInstant(day.year, day.month, day.day, clock.hour, clock.minute, timeZone);
            if (at.getTime() <= now.getTime())
                continue;
            if (!best || at.getTime() < best.at.getTime())
                best = { slot, at };
        }
    }
    return best;
}
function inOrNearMealWindow(now, meals) {
    const parts = zonedParts(now, meals.timezone);
    for (let add = -1; add <= 1; add += 1) {
        const day = shiftDate(parts.year, parts.month, parts.day, add);
        for (const hm of [meals.lunch, meals.dinner]) {
            const clock = parseHm(hm);
            if (!clock)
                continue;
            const target = zonedInstant(day.year, day.month, day.day, clock.hour, clock.minute, meals.timezone);
            const start = target.getTime() - meals.prepMinutes * 60_000;
            const end = target.getTime() + meals.lingerMinutes * 60_000;
            if (now.getTime() >= start && now.getTime() < end)
                return true;
        }
    }
    return false;
}
function shiftDate(year, month, day, days) {
    const shifted = new Date(Date.UTC(year, month - 1, day + days));
    return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}
export async function runInit(options) {
    const emit = options.emit ?? (() => { });
    const city = await requireText("城市（例如上海）", options.city, options);
    const keyword = await requireText("关键词（路名或门店，例如南京西路）", options.keyword, options);
    const called = [];
    const caller = gateCaller(options.caller, called);
    const storePayload = await readTool(caller, "query-nearby-stores", {
        searchType: 2,
        beType: 1,
        city,
        keyword,
    });
    const stores = extractStores(storePayload).filter((store) => store.storeCode);
    if (stores.length === 0) {
        throw new UserError("query-nearby-stores：0 家门店。换一个城市或关键词再试。没有写入配置，也没有下单。");
    }
    const storeToken = options.store?.trim() ?? "";
    const storeKnown = storeToken !== "" && pickByToken(stores, storeToken, (store) => store.storeCode) != null;
    if (!storeKnown)
        emit(formatStoreChoices(stores));
    const store = await chooseStore(stores, options, emit);
    const reservationDate = nextMealReservationDate(options.now ?? new Date());
    const mealPayload = await readTool(caller, "query-meals", {
        storeCode: store.storeCode,
        beType: 1,
        orderType: 1,
        reservationDate,
    });
    const menu = extractMeals(mealPayload);
    if (menu.length === 0) {
        throw new UserError("这家店的菜单是空的。没有写入配置，也没有下单。");
    }
    const itemTokens = (options.items ?? []).flatMap(splitChoices);
    const itemsKnown = itemTokens.length > 0 && itemTokens.every((token) => pickByToken(menu, token, (item) => item.code));
    if (!itemsKnown)
        emit(formatMenuListing(menu, options.menuAll === true || itemTokens.length > 0, options.interactive));
    const items = await chooseItems(menu, options, emit);
    let mealsEnabled = options.mealsEnabled;
    if (options.askMeals && !mealsEnabled && options.interactive) {
        const answer = await askOnce("要在状态栏提醒午饭和晚饭吗？默认工作日 12:00 和 18:30，不弹窗，只核价。 [Y/n] ", options);
        mealsEnabled = isYes(answer);
    }
    const usual = {
        label: usualLabel(items),
        items: items.map((item) => ({ productCode: item.code, quantity: 1 })),
    };
    const storeConfig = {
        storeCode: store.storeCode,
        beType: 1,
        orderType: 1,
        takeWayCode: "eat-in",
    };
    return {
        configText: filledConfigText({ mealsEnabled, store: storeConfig, usual }),
        called,
        store,
        items,
        mealsEnabled,
        reservationDate,
    };
}
function gateCaller(inner, called) {
    return {
        listTools: () => inner.listTools(),
        async callTool(name, args) {
            assertInitTool(name);
            called.push(name);
            return inner.callTool(name, args);
        },
    };
}
async function readTool(caller, name, args) {
    const result = await caller.callTool(name, args);
    if (result.isError)
        throw new UserError(`${name} 返回错误。没有写入配置，也没有下单。`);
    const payload = unwrapPayload(result);
    const failed = businessFailed(payload);
    if (failed)
        throw new UserError(`${name}：${failed} 没有写入配置，也没有下单。`);
    return payload;
}
async function requireText(label, value, options) {
    const given = value?.trim();
    if (given)
        return given;
    if (!options.interactive) {
        throw new UserError(`还缺少${label}。非交互环境请同时提供 --city 和 --keyword。没有写入配置，也没有下单。`);
    }
    const answer = (await askOnce(`${label}：`, options)).trim();
    if (!answer)
        throw new UserError("已取消，没有写入配置，也没有下单。");
    return answer;
}
async function chooseStore(stores, options, emit) {
    const initial = options.store?.trim() ?? "";
    if (initial) {
        const picked = pickByToken(stores, initial, (store) => store.storeCode);
        if (!picked) {
            throw new UserError(`查询结果里没有「${initial}」。请换序号或门店编码。没有写入配置，也没有下单。`);
        }
        return picked;
    }
    if (!options.interactive) {
        throw new UserError("非交互环境请加上 --store <序号或门店编码>。上面是查询结果。没有写入配置，也没有下单。", 2);
    }
    return askUntil("选一家，输入序号或门店编码：", (token) => pickByToken(stores, token, (store) => store.storeCode), "没有这个序号或门店编码，请再选一次。", options, emit);
}
async function chooseItems(menu, options, emit) {
    const provided = (options.items ?? []).flatMap(splitChoices);
    if (provided.length > 0)
        return resolveItems(menu, provided);
    if (!options.interactive) {
        throw new UserError("非交互环境请加上 --item <序号或餐品编码>，可以重复。上面是菜单。没有写入配置，也没有下单。", 2);
    }
    let misses = 0;
    while (misses < 5) {
        const answer = await askOnce("选常点的餐品，输入序号或编码，多个用逗号或空格分开。直接回车选 1：", options);
        if (isMenuAllAnswer(answer)) {
            emit(formatMenuListing(menu, true));
            continue;
        }
        const tokens = answer.trim() ? splitChoices(answer) : ["1"];
        const missing = tokens.filter((token) => !pickByToken(menu, token, (item) => item.code));
        if (missing.length === 0)
            return resolveItems(menu, tokens);
        misses += 1;
        emit(`菜单里没有 ${missing.join("、")}，请再选一次。`);
    }
    throw new UserError("多次没有选中餐品。没有写入配置，也没有下单。");
}
function isMenuAllAnswer(answer) {
    const text = answer.trim().toLowerCase();
    return text === "all" || text === "全部" || text === "--menu-all";
}
function resolveItems(menu, tokens) {
    const picked = [];
    const seen = new Set();
    for (const token of tokens) {
        const item = pickByToken(menu, token, (meal) => meal.code);
        if (!item) {
            throw new UserError(`菜单里没有「${token}」。请用序号或餐品编码。没有写入配置，也没有下单。`);
        }
        if (seen.has(item.code))
            continue;
        seen.add(item.code);
        picked.push(item);
    }
    if (picked.length === 0)
        throw new UserError("还没有选择餐品。没有写入配置，也没有下单。");
    return picked;
}
async function askUntil(prompt, pick, retry, options, emit) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const answer = (await askOnce(prompt, options)).trim();
        if (!answer)
            throw new UserError("已取消，没有写入配置，也没有下单。");
        const picked = pick(answer);
        if (picked)
            return picked;
        emit(retry);
    }
    throw new UserError("多次没有选中，已取消。没有写入配置，也没有下单。");
}
function askOnce(prompt, options) {
    if (!options.prompter)
        throw new UserError("交互输入不可用。没有写入配置，也没有下单。");
    return options.prompter.ask(prompt);
}
function isYes(answer) {
    const text = answer.trim().toLowerCase();
    return text === "" || text === "y" || text === "yes" || text === "是";
}
function usualLabel(items) {
    const joined = items.map((item) => item.name).join("、");
    if (joined.length <= 40)
        return joined;
    const first = items[0]?.name ?? "常点一份";
    if (items.length === 1)
        return first.slice(0, 40);
    return "常点一份";
}
//# sourceMappingURL=init-config.js.map