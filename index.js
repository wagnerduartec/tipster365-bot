import TelegramBot from "node-telegram-bot-api";
import OpenAI from "openai";
import fetch from "node-fetch";

const telegramToken = process.env.TELEGRAM_TOKEN;
const openaiKey = process.env.OPENAI_API_KEY;
const oddsApiKey = process.env.ODDS_API_KEY;

if (!telegramToken) throw new Error("Falta TELEGRAM_TOKEN");
if (!openaiKey) throw new Error("Falta OPENAI_API_KEY");
if (!oddsApiKey) throw new Error("Falta ODDS_API_KEY");

const bot = new TelegramBot(telegramToken, { polling: true });
const client = new OpenAI({ apiKey: openaiKey });

const pendingRequests = new Map();

// ================= DATA =================

function formatDateBR(isoDate) {
  return new Date(isoDate).toLocaleString("pt-BR", {
    timeZone: "America/Fortaleza",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function parseBRDate(dateStr) {
  const [d, m, y] = dateStr.split("/");
  return `${y}-${m}-${d}`;
}

function toUtcRange(period) {
  const iso = parseBRDate(period);
  return {
    start: new Date(`${iso}T00:00:00-03:00`).toISOString(),
    end: new Date(`${iso}T23:59:59-03:00`).toISOString(),
  };
}

// ================= API =================

async function fetchJson(url) {
  const r = await fetch(url);
  return r.json();
}

async function buscarOdds(period, sportKey, lightweight = false) {
  const { start, end } = toUtcRange(period);

  const params = new URLSearchParams({
    apiKey: oddsApiKey,
    regions: "eu",
    markets: lightweight ? "h2h" : "h2h,totals",
    commenceTimeFrom: start,
    commenceTimeTo: end,
  });

  const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds?${params}`;
  return fetchJson(url);
}

async function buscarLigas() {
  const url = `https://api.the-odds-api.com/v4/sports?apiKey=${oddsApiKey}`;
  const sports = await fetchJson(url);

  return sports
    .filter(s => s.key.startsWith("soccer_"))
    .map(s => ({ key: s.key, label: s.title }));
}

// ================= NOVO: LIGAS COM EVENTOS =================

async function contarEventosLiga(period, liga) {
  try {
    const odds = await buscarOdds(period, liga.key, true);
    return {
      key: liga.key,
      label: liga.label,
      count: Array.isArray(odds) ? odds.length : 0,
    };
  } catch {
    return { key: liga.key, label: liga.label, count: 0 };
  }
}

async function buscarLigasComEventos(period) {
  const ligas = await buscarLigas();
  const resultados = [];

  for (let i = 0; i < ligas.length; i += 5) {
    const batch = ligas.slice(i, i + 5);

    const res = await Promise.all(
      batch.map(l => contarEventosLiga(period, l))
    );

    resultados.push(...res);
  }

  return resultados
    .filter(l => l.count > 0) // 🔥 só ligas com jogos
    .sort((a, b) => b.count - a.count);
}

function montarListaLigas(ligas) {
  return ligas
    .map((l, i) => `${i + 1}. ${l.label} (${l.count})`)
    .join("\n");
}

// ================= SCORE =================

function gerarScore(jogo) {
  const linha = jogo.bookmakers?.[0]?.markets?.find(m => m.key === "totals")?.outcomes;

  if (!linha) return null;

  const over = linha.find(o => o.name === "Over" && o.point === 2.5);
  const under = linha.find(o => o.name === "Under" && o.point === 2.5);

  if (!over || !under) return null;

  let score = 0;
  const prob = (1 / over.price) / ((1 / over.price) + (1 / under.price));

  if (prob > 0.6) score += 30;
  if (over.price >= 1.5 && over.price <= 1.8) score += 30;
  if (Math.abs(over.price - under.price) < 0.3) score += 20;
  if (jogo.bookmakers.length >= 5) score += 20;

  return {
    score,
    odd: over.price,
    mercado: "Over 2.5"
  };
}

function gerarTop(jogos) {
  return jogos
    .map(j => {
      const s = gerarScore(j);
      if (!s) return null;
      return { ...j, ...s };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, 50);
}

// ================= BOT =================

bot.onText(/\/start/, msg => {
  bot.sendMessage(msg.chat.id, "Use /analise");
});

bot.onText(/\/analise/, msg => {
  pendingRequests.set(msg.chat.id, { step: "data" });
  bot.sendMessage(msg.chat.id, "Digite a data (ex: 05/04/2026)");
});

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  const pending = pendingRequests.get(chatId);

  if (!pending) return;

  // STEP DATA
  if (pending.step === "data") {
    const ligas = await buscarLigasComEventos(text);

    pendingRequests.set(chatId, {
      step: "ligas",
      period: text,
      ligas
    });

    const lista = montarListaLigas(ligas);

    bot.sendMessage(chatId, "Escolha as ligas (ex: 1,2,3):\n\n" + lista);
    return;
  }

  // STEP LIGAS
  if (pending.step === "ligas") {
    const escolhas = text.split(",").map(x => Number(x.trim()) - 1);
    const selecionadas = escolhas.map(i => pending.ligas[i]).filter(Boolean);

    let jogos = [];

    for (const liga of selecionadas) {
      const odds = await buscarOdds(pending.period, liga.key);

      odds.forEach(j => {
        jogos.push({
          ...j,
          liga: liga.label,
          jogo: `${j.home_team} x ${j.away_team}`,
          horario: formatDateBR(j.commence_time)
        });
      });
    }

    const top = gerarTop(jogos);

    let resposta = "🔥 TOP 50 DO DIA\n\n";

    top.forEach((j, i) => {
      resposta += `${i + 1}. ${j.jogo}\n🏆 ${j.liga}\n⏰ ${j.horario}\n📊 ${j.score}%\n💰 ${j.odd}\n\n`;
    });

    bot.sendMessage(chatId, resposta);

    pendingRequests.delete(chatId);
  }
});

console.log("🔥 Bot rodando com filtro de ligas + TOP 50");
