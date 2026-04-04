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
    regions: "eu,uk",
    markets: lightweight ? "h2h" : "h2h,totals,btts",
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

// ================= LIGAS COM EVENTOS =================

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
    .filter(l => l.count > 0)
    .sort((a, b) => b.count - a.count);
}

function montarListaLigas(ligas) {
  return ligas
    .map((l, i) => `${i + 1}. ${l.label} (${l.count})`)
    .join("\n");
}

// ================= SCORE INTELIGENTE =================

function calcularScore(over, under, books, peso = 1) {
  const prob = (1 / over) / ((1 / over) + (1 / under));

  let score = 0;

  if (prob > 0.55) score += 30;
  if (over >= 1.4 && over <= 2.2) score += 30;
  if (Math.abs(over - under) < 0.5) score += 20;
  if (books >= 3) score += 20;

  return Math.round(score * peso);
}

function gerarScoreSeguro(jogo) {
  let candidatos = [];

  for (const book of jogo.bookmakers || []) {
    for (const market of book.markets || []) {

      // OVER 2.5
      if (market.key === "totals") {
        const over25 = market.outcomes?.find(o => o.name === "Over" && o.point === 2.5);
        const under25 = market.outcomes?.find(o => o.name === "Under" && o.point === 2.5);

        if (over25 && under25) {
          candidatos.push({
            tipo: "OVER 2.5",
            odd: over25.price,
            score: calcularScore(over25.price, under25.price, jogo.bookmakers.length, 1)
          });
        }

        // OVER 1.5
        const over15 = market.outcomes?.find(o => o.name === "Over" && o.point === 1.5);
        const under15 = market.outcomes?.find(o => o.name === "Under" && o.point === 1.5);

        if (over15 && under15) {
          candidatos.push({
            tipo: "OVER 1.5",
            odd: over15.price,
            score: calcularScore(over15.price, under15.price, jogo.bookmakers.length, 0.8)
          });
        }
      }

      // BTTS
      if (market.key === "btts") {
        const sim = market.outcomes?.find(o => o.name === "Yes");
        const nao = market.outcomes?.find(o => o.name === "No");

        if (sim && nao) {
          candidatos.push({
            tipo: "BTTS SIM",
            odd: sim.price,
            score: calcularScore(sim.price, nao.price, jogo.bookmakers.length, 0.7)
          });
        }
      }

      // fallback vitória
      if (market.key === "h2h") {
        const favorito = market.outcomes?.sort((a, b) => a.price - b.price)[0];

        if (favorito) {
          candidatos.push({
            tipo: `VITÓRIA ${favorito.name}`,
            odd: favorito.price,
            score: 40
          });
        }
      }
    }
  }

  if (candidatos.length === 0) return null;

  return candidatos.sort((a, b) => b.score - a.score)[0];
}

function gerarTopSeguro(jogos) {
  let analisados = jogos
    .map(j => {
      const s = gerarScoreSeguro(j);
      if (!s) return null;
      return { ...j, ...s };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  if (analisados.length === 0) {
    return jogos.slice(0, 20).map(j => ({
      ...j,
      score: 50,
      odd: 1.5,
      tipo: "JOGO EQUILIBRADO"
    }));
  }

  return analisados.slice(0, 50);
}

// ================= BOT =================

bot.onText(/\/analise/, msg => {
  pendingRequests.set(msg.chat.id, { step: "data" });
  bot.sendMessage(msg.chat.id, "Digite a data (ex: 05/04/2026)");
});

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  const pending = pendingRequests.get(chatId);

  if (!pending) return;

  // DATA
  if (pending.step === "data") {
    const ligas = await buscarLigasComEventos(text);

    pendingRequests.set(chatId, {
      step: "ligas",
      period: text,
      ligas
    });

    bot.sendMessage(chatId, "Escolha as ligas:\n\n" + montarListaLigas(ligas));
    return;
  }

  // LIGAS
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

    console.log("TOTAL JOGOS:", jogos.length);

    const top = gerarTopSeguro(jogos);

    let resposta = "🔥 TOP 50 DO DIA\n\n";

    top.forEach((j, i) => {
      resposta += `${i + 1}. ${j.jogo}\n🏆 ${j.liga}\n⏰ ${j.horario}\n📊 ${j.score}%\n🎯 ${j.tipo}\n💰 ${j.odd}\n\n`;
    });

    bot.sendMessage(chatId, resposta);

    pendingRequests.delete(chatId);
  }
});

console.log("🔥 BOT 100% OPERACIONAL");
