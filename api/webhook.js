import { DateTime } from "luxon";

const OKX_REST = "https://www.okx.com";
const INST_TYPE = "SWAP"; // OKX perpetuals

/**
 * ВАЖНО:
 * - Работает на Vercel Free без cron: запуск через команды в Telegram.
 * - /set меняет настройки best-effort (в памяти). При холодном старте может сброситься.
 * - Надёжно хранить настройки можно через KV/Redis (если захочешь — дам версию).
 */

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).send("POST only");

    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN");

    const update = req.body ?? {};
    const msg = update.message || update.edited_message;
    const chatId = msg?.chat?.id;
    const text = (msg?.text || "").trim();

    if (!chatId) return res.status(200).json({ ok: true });

    // owner-guard: команды сканера только владельцу
    const owner = process.env.CHAT_ID;
    const isOwner = owner && String(chatId) === String(owner);

    // /start
    if (text.startsWith("/start")) {
      const reply =
        `Готово ✅\n` +
        `Твой chat_id: ${chatId}\n\n` +
        `1) Добавь CHAT_ID=${chatId} в Vercel Env\n` +
        `2) Redeploy\n` +
        `3) Команды: /help\n\n` +
        `TZ: Europe/Warsaw (для /today)`;
      await tgSendMessage(token, chatId, reply);
      return res.status(200).json({ ok: true });
    }

    // /help
    if (text.startsWith("/help")) {
      const s = getSettings();
      const reply =
        `Команды:\n` +
        `1) /status — настройки\n` +
        `2) /scan — “памп старт” сейчас (строгий сигнал)\n` +
        `3) /today [N] — кто пампился сегодня с 00:00 Poland до сейчас\n` +
        `4) /momentum [N] — кто разгоняется сейчас (вероятный импульс)\n` +
        `5) /set key=value ... — настройки (best-effort)\n\n` +
        `Примеры:\n` +
        `/today 20\n` +
        `/momentum 15\n` +
        `/set TOP_N=80 BAR=15m PUMP_TODAY_PCT=6 MOM_PCT=2 VOL_MULT=2\n\n` +
        `Текущие:\n` +
        `TOP_N=${s.TOP_N} BAR=${s.BAR} WINDOW_MIN=${s.WINDOW_MIN}\n` +
        `PUMP_PCT=${s.PUMP_PCT} VOL_MULT=${s.VOL_MULT}\n` +
        `PUMP_TODAY_PCT=${s.PUMP_TODAY_PCT} MOM_PCT=${s.MOM_PCT}`;
      await tgSendMessage(token, chatId, reply);
      return res.status(200).json({ ok: true });
    }

    // Owner only дальше
    if (!isOwner) {
      await tgSendMessage(token, chatId, "Доступ запрещён. Нужен CHAT_ID владельца.");
      return res.status(200).json({ ok: true });
    }

    // /status
    if (text.startsWith("/status")) {
      const s = getSettings();
      await tgSendMessage(
        token,
        chatId,
        `Статус ⚙️\n` +
          `instType: ${INST_TYPE}\n` +
          `TOP_N=${s.TOP_N}\n` +
          `BAR=${s.BAR}\n` +
          `WINDOW_MIN=${s.WINDOW_MIN}\n` +
          `PUMP_PCT=${s.PUMP_PCT}\n` +
          `VOL_MULT=${s.VOL_MULT}\n` +
          `COOLDOWN_MIN=${s.COOLDOWN_MIN}\n` +
          `PUMP_TODAY_PCT=${s.PUMP_TODAY_PCT}\n` +
          `MOM_PCT=${s.MOM_PCT}\n` +
          `TZ(today)=Europe/Warsaw\n\n` +
          `Команды: /scan /today /momentum /set`
      );
      return res.status(200).json({ ok: true });
    }

    // /set key=value key=value ...
    if (text.startsWith("/set")) {
      const args = text.replace("/set", "").trim();
      if (!args) {
        await tgSendMessage(
          token,
          chatId,
          `Формат:\n` +
            `/set TOP_N=80 BAR=15m PUMP_TODAY_PCT=6 MOM_PCT=2 VOL_MULT=2\n\n` +
            `Можно менять: TOP_N, BAR(1m/5m/15m), WINDOW_MIN, PUMP_PCT, VOL_MULT, COOLDOWN_MIN, PUMP_TODAY_PCT, MOM_PCT`
        );
        return res.status(200).json({ ok: true });
      }

      const changes = parseKeyValues(args);
      const applied = applySettings(changes);

      await tgSendMessage(
        token,
        chatId,
        `Принято (best-effort) ✅\n` +
          applied.map(([k, v]) => `${k}=${v}`).join("\n") +
          `\n\nПосмотреть: /status`
      );
      return res.status(200).json({ ok: true });
    }

    // /scan (строгий “памп старт” как раньше)
    if (text.startsWith("/scan")) {
      await tgSendMessage(token, chatId, "Сканирую OKX… ⏳");
      const alerts = await scanOkxForPumps();
      if (!alerts.length) {
        await tgSendMessage(token, chatId, "Пока тихо. Ничего не пампит по твоим правилам.");
      } else {
        for (const c of chunkText(alerts.join("\n\n"), 3500)) {
          await tgSendMessage(token, chatId, c);
        }
      }
      return res.status(200).json({ ok: true });
    }

    // /today [N]
    if (text.startsWith("/today")) {
      const topK = clampInt(parseInt(text.split(/\s+/)[1] || "15", 10), 1, 30);
      await tgSendMessage(token, chatId, "Считаю пампы за сегодня (Europe/Warsaw)… ⏳");
      const out = await todayPumps(topK);
      for (const c of chunkText(out, 3500)) await tgSendMessage(token, chatId, c);
      return res.status(200).json({ ok: true });
    }

    // /momentum [N]
    if (text.startsWith("/momentum")) {
      const topK = clampInt(parseInt(text.split(/\s+/)[1] || "15", 10), 1, 30);
      await tgSendMessage(token, chatId, "Ищу монеты, которые набирают обороты… ⏳");
      const out = await momentumPicks(topK);
      for (const c of chunkText(out, 3500)) await tgSendMessage(token, chatId, c);
      return res.status(200).json({ ok: true });
    }

    // fallback
    await tgSendMessage(token, chatId, "Команды: /help");
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}

// ------------------- SETTINGS -------------------

const memSettings = globalThis.__memSettings || null;
if (!globalThis.__memSettings) globalThis.__memSettings = null;

function getSettings() {
  // ENV defaults
  const env = {
    TOP_N: parseInt(process.env.TOP_N || "50", 10),
    BAR: process.env.BAR || "15m", // today/momentum лучше 15m
    WINDOW_MIN: parseInt(process.env.WINDOW_MIN || "5", 10),
    PUMP_PCT: parseFloat(process.env.PUMP_PCT || "3"),
    VOL_MULT: parseFloat(process.env.VOL_MULT || "3"),
    COOLDOWN_MIN: parseInt(process.env.COOLDOWN_MIN || "15", 10),
    PUMP_TODAY_PCT: parseFloat(process.env.PUMP_TODAY_PCT || "6"),
    MOM_PCT: parseFloat(process.env.MOM_PCT || "2")
  };

  const m = globalThis.__memSettings;
  if (!m) return sanitizeSettings(env);

  return sanitizeSettings({ ...env, ...m });
}

function sanitizeSettings(s) {
  const out = { ...s };
  out.TOP_N = clampInt(out.TOP_N, 10, 200);
  out.WINDOW_MIN = clampInt(out.WINDOW_MIN, 1, 30);
  out.PUMP_PCT = clampFloat(out.PUMP_PCT, 0.2, 50);
  out.VOL_MULT = clampFloat(out.VOL_MULT, 1, 50);
  out.COOLDOWN_MIN = clampInt(out.COOLDOWN_MIN, 0, 240);
  out.PUMP_TODAY_PCT = clampFloat(out.PUMP_TODAY_PCT, 0.5, 200);
  out.MOM_PCT = clampFloat(out.MOM_PCT, 0.2, 50);

  // ограничим bar только разумными
  const allowedBars = new Set(["1m", "3m", "5m", "15m", "30m", "1H", "2H", "4H"]);
  out.BAR = allowedBars.has(out.BAR) ? out.BAR : "15m";
  return out;
}

function applySettings(changes) {
  const current = getSettings();
  const next = { ...current };

  const allowed = new Set([
    "TOP_N",
    "BAR",
    "WINDOW_MIN",
    "PUMP_PCT",
    "VOL_MULT",
    "COOLDOWN_MIN",
    "PUMP_TODAY_PCT",
    "MOM_PCT"
  ]);

  const applied = [];
  for (const [k, v] of Object.entries(changes)) {
    if (!allowed.has(k)) continue;

    // parse types
    if (["TOP_N", "WINDOW_MIN", "COOLDOWN_MIN"].includes(k)) next[k] = parseInt(String(v), 10);
    else if (k === "BAR") next[k] = String(v).trim();
    else next[k] = parseFloat(String(v));

    applied.push([k, next[k]]);
  }

  globalThis.__memSettings = sanitizeSettings(next);
  return applied;
}

function parseKeyValues(s) {
  // "A=1 B=2" OR "A=1,B=2"
  const parts = s.replace(/,/g, " ").split(/\s+/).filter(Boolean);
  const out = {};
  for (const p of parts) {
    const i = p.indexOf("=");
    if (i === -1) continue;
    const k = p.slice(0, i).trim();
    const v = p.slice(i + 1).trim();
    if (!k) continue;
    out[k] = v;
  }
  return out;
}

function clampInt(n, lo, hi) {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.trunc(n)));
}
function clampFloat(n, lo, hi) {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

// ------------------- TODAY PUMPS (00:00 Warsaw) -------------------

function warsawStartOfDayUtcMs() {
  return DateTime.now().setZone("Europe/Warsaw").startOf("day").toUTC().toMillis();
}

function parseCandle(r) {
  // OKX candles: [ts, o, h, l, c, vol, volCcy, ...]
  return {
    ts: Number(r[0]),
    o: Number(r[1]),
    h: Number(r[2]),
    l: Number(r[3]),
    c: Number(r[4]),
    volCcy: Number(r[6])
  };
}

async function todayPumps(topK) {
  const s = getSettings();
  const startMs = warsawStartOfDayUtcMs();
  const nowMs = Date.now();

  const tickers = await okxGetJson(`/api/v5/market/tickers?instType=${INST_TYPE}`);
  const universe = (tickers?.data || [])
    .filter(t => t.instId?.endsWith("-USDT-SWAP"))
    .map(t => ({ instId: t.instId, volCcy24h: Number(t.volCcy24h) }))
    .filter(x => Number.isFinite(x.volCcy24h))
    .sort((a, b) => b.volCcy24h - a.volCcy24h)
    .slice(0, s.TOP_N);

  const results = [];

  for (const u of universe) {
    // 15m*96=24h. Для 1m было бы 1440 (слишком тяжело).
    const limit = s.BAR === "1m" ? 360 : 96; // защитный лимит
    const candles = await okxGetJson(
      `/api/v5/market/candles?instId=${encodeURIComponent(u.instId)}&bar=${encodeURIComponent(s.BAR)}&limit=${limit}`
    );

    let rows = (candles?.data || []).map(parseCandle).filter(x => Number.isFinite(x.ts));
    rows.sort((a, b) => a.ts - b.ts);

    rows = rows.filter(x => x.ts >= startMs && x.ts <= nowMs);
    if (rows.length < 2) continue;

    const open00 = rows[0].o;
    const maxHigh = Math.max(...rows.map(x => x.h));
    if (!Number.isFinite(open00) || open00 <= 0) continue;

    const pumpPct = ((maxHigh - open00) / open00) * 100;
    if (pumpPct < s.PUMP_TODAY_PCT) continue;

    results.push({ instId: u.instId, pumpPct });
  }

  results.sort((a, b) => b.pumpPct - a.pumpPct);
  const top = results.slice(0, topK);

  if (!top.length) {
    return `Сегодня (Europe/Warsaw) по порогу PUMP_TODAY_PCT=${s.PUMP_TODAY_PCT}% никого.\n` +
           `Подсказка: /set PUMP_TODAY_PCT=4 TOP_N=100 BAR=15m`;
  }

  const lines = top.map((x, i) => `${i + 1}) ${x.instId}  +${x.pumpPct.toFixed(2)}% (max от 00:00 Warsaw)`);
  return `Пампились сегодня (с 00:00 Europe/Warsaw):\n` + lines.join("\n");
}

// ------------------- MOMENTUM (probable pump) -------------------

async function momentumPicks(topK) {
  const s = getSettings();

  const tickers = await okxGetJson(`/api/v5/market/tickers?instType=${INST_TYPE}`);
  const universe = (tickers?.data || [])
    .filter(t => t.instId?.endsWith("-USDT-SWAP"))
    .map(t => ({ instId: t.instId, volCcy24h: Number(t.volCcy24h) }))
    .filter(x => Number.isFinite(x.volCcy24h))
    .sort((a, b) => b.volCcy24h - a.volCcy24h)
    .slice(0, s.TOP_N);

  const picks = [];

  for (const u of universe) {
    const candles = await okxGetJson(
      `/api/v5/market/candles?instId=${encodeURIComponent(u.instId)}&bar=${encodeURIComponent(s.BAR)}&limit=48`
    );

    let rows = (candles?.data || []).map(parseCandle).filter(x => Number.isFinite(x.ts));
    rows.sort((a, b) => a.ts - b.ts);
    if (rows.length < 24) continue;

    const last3 = rows.slice(-3);
    const prev = rows.slice(0, -3);

    const start = last3[0].o;
    const end = last3[last3.length - 1].c;
    if (!Number.isFinite(start) || start <= 0) continue;

    const momPct = ((end - start) / start) * 100;

    const volLast3 = sum(last3.map(x => x.volCcy || 0));
    const prev24 = prev.slice(-24);
    const volAvg1 = sum(prev24.map(x => x.volCcy || 0)) / prev24.length; // avg per candle
    // сравнение на 3 свечи: volLast3 vs (volAvg1*3)
    const volMult = (volAvg1 > 0) ? (volLast3 / (volAvg1 * 3)) : 0;

    const high12 = Math.max(...rows.slice(-12).map(x => x.h));
    const broke = end >= high12;

    if (momPct >= s.MOM_PCT && volMult >= s.VOL_MULT && broke) {
      picks.push({ instId: u.instId, momPct, volMult });
    }
  }

  picks.sort((a, b) => (b.momPct * 0.7 + b.volMult * 0.3) - (a.momPct * 0.7 + a.volMult * 0.3));
  const top = picks.slice(0, topK);

  if (!top.length) {
    return `Сейчас нет явных “разгонов” по MOM_PCT=${s.MOM_PCT}% и VOL_MULT=${s.VOL_MULT}×.\n` +
           `Подсказка: /set MOM_PCT=1.2 VOL_MULT=1.6 TOP_N=100`;
  }

  const lines = top.map((x, i) =>
    `${i + 1}) ${x.instId}  mom:+${x.momPct.toFixed(2)}%  vol:${x.volMult.toFixed(2)}×`
  );
  return `Набирают обороты (вероятный импульс):\n` + lines.join("\n");
}

// ------------------- STRICT PUMP START (как раньше) -------------------

async function scanOkxForPumps() {
  const s = getSettings();
  const now = Date.now();

  const tickers = await okxGetJson(`/api/v5/market/tickers?instType=${INST_TYPE}`);
  const list = (tickers?.data || [])
    .filter(t => typeof t.instId === "string" && t.instId.endsWith("-USDT-SWAP"))
    .map(t => ({
      instId: t.instId,
      last: Number(t.last),
      volCcy24h: Number(t.volCcy24h)
    }))
    .filter(t => Number.isFinite(t.last) && Number.isFinite(t.volCcy24h))
    .sort((a, b) => b.volCcy24h - a.volCcy24h)
    .slice(0, s.TOP_N);

  const alerts = [];

  for (const item of list) {
    if (isCoolingDown(item.instId, now, s.COOLDOWN_MIN)) continue;

    const candles = await okxGetJson(
      `/api/v5/market/candles?instId=${encodeURIComponent(item.instId)}&bar=1m&limit=60`
    );

    const rows = (candles?.data || []).map(parseCandle).filter(x => Number.isFinite(x.ts));
    rows.sort((a, b) => a.ts - b.ts);
    if (rows.length < Math.max(10, s.WINDOW_MIN + 5)) continue;

    const n = rows.length;
    const window = rows.slice(n - s.WINDOW_MIN);
    const prev = rows.slice(0, n - s.WINDOW_MIN);
    if (window.length < s.WINDOW_MIN || prev.length < 10) continue;

    const first = window[0].o;
    const last = window[window.length - 1].c;
    if (!Number.isFinite(first) || first <= 0) continue;

    const pct = ((last - first) / first) * 100;

    const volWin = sum(window.map(x => x.volCcy || 0));
    const avgWinFromPrev = sum(prev.map(x => x.volCcy || 0)) / (prev.length / s.WINDOW_MIN);
    const volMult = avgWinFromPrev > 0 ? (volWin / avgWinFromPrev) : 0;

    const high60 = Math.max(...rows.slice(0, n - 1).map(x => x.h));
    const brokeHigh = last > high60;

    const pumped = pct >= s.PUMP_PCT && volMult >= s.VOL_MULT && brokeHigh;

    if (pumped) {
      markCooldown(item.instId, now, s.COOLDOWN_MIN);
      alerts.push(
        `🚨 PUMP START\n` +
        `${item.instId}\n` +
        `Δ${s.WINDOW_MIN}m: +${pct.toFixed(2)}%\n` +
        `Vol spike: ${volMult.toFixed(2)}×\n` +
        `Break 60m high: yes\n` +
        `Last: ${item.last}`
      );
    }
  }

  return alerts;
}

// ------------------- HELPERS -------------------

async function okxGetJson(path) {
  const r = await fetch(`${OKX_REST}${path}`, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`OKX HTTP ${r.status} for ${path}`);
  return await r.json();
}

async function tgSendMessage(token, chatId, text) {
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true })
  });
  if (!r.ok) {
    const body = await r.text();
    console.error("Telegram sendMessage failed:", r.status, body);
  }
}

function sum(arr) {
  return arr.reduce((a, b) => a + b, 0);
}

function chunkText(text, maxLen) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    out.push(text.slice(i, i + maxLen));
    i += maxLen;
  }
  return out;
}

// best-effort cooldown (в памяти)
const cooldownMap = globalThis.__cooldownMap || new Map();
globalThis.__cooldownMap = cooldownMap;

function isCoolingDown(instId, nowMs) {
  const until = cooldownMap.get(instId);
  return typeof until === "number" && nowMs < until;
}
function markCooldown(instId, nowMs, cooldownMin) {
  cooldownMap.set(instId, nowMs + cooldownMin * 60_000);
}
