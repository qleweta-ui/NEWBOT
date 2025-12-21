const OKX_REST = "https://www.okx.com";
const INST_TYPE = "SWAP";

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

    // Команды
    if (text.startsWith("/start")) {
      const reply =
        `Готово ✅\n` +
        `Твой chat_id: ${chatId}\n\n` +
        `1) Добавь CHAT_ID=${chatId} в Vercel Env\n` +
        `2) Напиши /scan чтобы просканить OKX\n\n` +
        `Параметры (ENV): TOP_N, PUMP_PCT, VOL_MULT, WINDOW_MIN, COOLDOWN_MIN, BAR`;

      await tgSendMessage(token, chatId, reply);
      return res.status(200).json({ ok: true });
    }

    if (text.startsWith("/status")) {
      const s = currentSettings();
      await tgSendMessage(token, chatId,
        `Статус ⚙️\n` +
        `instType: ${INST_TYPE}\n` +
        `TOP_N=${s.TOP_N}\n` +
        `BAR=${s.BAR}\n` +
        `WINDOW_MIN=${s.WINDOW_MIN}\n` +
        `PUMP_PCT=${s.PUMP_PCT}\n` +
        `VOL_MULT=${s.VOL_MULT}\n` +
        `COOLDOWN_MIN=${s.COOLDOWN_MIN}\n\n` +
        `Команда: /scan`
      );
      return res.status(200).json({ ok: true });
    }

    if (text.startsWith("/scan")) {
      // Защита: отвечаем только владельцу (CHAT_ID)
      const owner = process.env.CHAT_ID;
      if (!owner) {
        await tgSendMessage(token, chatId, "Сначала добавь CHAT_ID в Env на Vercel (пришёл в /start).");
        return res.status(200).json({ ok: true });
      }
      if (String(chatId) !== String(owner)) {
        await tgSendMessage(token, chatId, "Доступ запрещён.");
        return res.status(200).json({ ok: true });
      }

      await tgSendMessage(token, chatId, "Сканирую OKX… ⏳");

      const alerts = await scanOkxForPumps();
      if (!alerts.length) {
        await tgSendMessage(token, chatId, "Пока тихо. Ничего не пампит по твоим правилам.");
      } else {
        // Telegram ограничивает длину сообщения, так что режем пачки
        const chunks = chunkText(alerts.join("\n\n"), 3500);
        for (const c of chunks) await tgSendMessage(token, chatId, c);
      }

      return res.status(200).json({ ok: true });
    }

    // Фолбэк
    await tgSendMessage(token, chatId, "Команды: /start, /status, /scan");
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}

// ---------- SCAN LOGIC ----------

async function scanOkxForPumps() {
  const s = currentSettings();
  const now = Date.now();

  const tickers = await okxGetJson(`/api/v5/market/tickers?instType=${INST_TYPE}`);

  const list = (tickers?.data || [])
    .filter(t => typeof t.instId === "string" && t.instId.endsWith("-USDT-SWAP"))
    .map(t => ({
      instId: t.instId,
      last: num(t.last),
      volCcy24h: num(t.volCcy24h)
    }))
    .filter(t => Number.isFinite(t.last) && Number.isFinite(t.volCcy24h))
    .sort((a, b) => b.volCcy24h - a.volCcy24h)
    .slice(0, s.TOP_N);

  const alerts = [];

  // Дёргаем свечи последовательно (безопаснее по лимитам)
  for (const item of list) {
    if (isCoolingDown(item.instId, now, s.COOLDOWN_MIN)) continue;

    const candles = await okxGetJson(
      `/api/v5/market/candles?instId=${encodeURIComponent(item.instId)}&bar=${encodeURIComponent(s.BAR)}&limit=60`
    );

    const rows = candles?.data || [];
    if (rows.length < Math.max(10, s.WINDOW_MIN + 5)) continue;

    const parsed = rows
      .map(r => ({
        ts: Number(r[0]),
        o: num(r[1]),
        h: num(r[2]),
        l: num(r[3]),
        c: num(r[4]),
        volCcy: num(r[6])
      }))
      .filter(x => Number.isFinite(x.c) && Number.isFinite(x.volCcy))
      .sort((a, b) => a.ts - b.ts);

    const n = parsed.length;
    const window = parsed.slice(n - s.WINDOW_MIN);
    const prev = parsed.slice(0, n - s.WINDOW_MIN);
    if (window.length < s.WINDOW_MIN || prev.length < 10) continue;

    const first = window[0].o;
    const last = window[window.length - 1].c;
    if (!Number.isFinite(first) || first <= 0) continue;

    const pct = ((last - first) / first) * 100;

    const volWin = sum(window.map(x => x.volCcy));
    const avgWinFromPrev = sum(prev.map(x => x.volCcy)) / (prev.length / s.WINDOW_MIN);
    const volMult = avgWinFromPrev > 0 ? (volWin / avgWinFromPrev) : 0;

    const high60 = Math.max(...parsed.slice(0, n - 1).map(x => x.h));
    const brokeHigh = last > high60;

    const pumped = pct >= s.PUMP_PCT && volMult >= s.VOL_MULT && brokeHigh;

    if (pumped) {
      markCooldown(item.instId, now, s.COOLDOWN_MIN);
      alerts.push(
        `🚨 PUMP START\n` +
        `${item.instId}\n` +
        `Δ${s.WINDOW_MIN}${s.BAR}: +${pct.toFixed(2)}%\n` +
        `Vol spike: ${volMult.toFixed(2)}×\n` +
        `Break 60m high: yes\n` +
        `Last: ${item.last}`
      );
    }
  }

  return alerts;
}

function currentSettings() {
  return {
    TOP_N: parseInt(process.env.TOP_N || "50", 10),
    BAR: process.env.BAR || "1m",
    WINDOW_MIN: parseInt(process.env.WINDOW_MIN || "5", 10),
    PUMP_PCT: parseFloat(process.env.PUMP_PCT || "3"),
    VOL_MULT: parseFloat(process.env.VOL_MULT || "3"),
    COOLDOWN_MIN: parseInt(process.env.COOLDOWN_MIN || "15", 10)
  };
}

// ---------- HELPERS ----------

async function okxGetJson(path) {
  const r = await fetch(`${OKX_REST}${path}`, { headers: { "accept": "application/json" } });
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

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : NaN;
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

// best-effort антиспам
const cooldownMap = globalThis.__cooldownMap || new Map();
globalThis.__cooldownMap = cooldownMap;

function isCoolingDown(instId, nowMs, cooldownMin) {
  const until = cooldownMap.get(instId);
  return typeof until === "number" && nowMs < until;
}
function markCooldown(instId, nowMs, cooldownMin) {
  cooldownMap.set(instId, nowMs + cooldownMin * 60_000);
}
