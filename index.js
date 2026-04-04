import TelegramBot from "node-telegram-bot-api";
import OpenAI from "openai";

const telegramToken = process.env.TELEGRAM_TOKEN;
const openaiKey = process.env.OPENAI_API_KEY;
const oddsApiKey = process.env.ODDS_API_KEY;

if (!telegramToken) throw new Error("Falta TELEGRAM_TOKEN");
if (!openaiKey) throw new Error("Falta OPENAI_API_KEY");
if (!oddsApiKey) throw new Error("Falta ODDS_API_KEY");

const bot = new TelegramBot(telegramToken, { polling: true });
const client = new OpenAI({ apiKey: openaiKey });

const MAX_EVENTS_FOR_AI = 80;

const pendingRequests = new Map();

function formatDateBR(isoDate) {
  try {
    return new Date(isoDate).toLocaleString("pt-BR", {
      timeZone: "America/Fortaleza",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return isoDate;
  }
}

function todayInFortalezaISO() {
  const now = new Date();
  const year = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Fortaleza", year: "numeric" }).format(now);
  const month = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Fortaleza", month: "2-digit" }).format(now);
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Fortaleza", day: "2-digit" }).format(now);
  return `${year}-${month}-${day}`;
}

function parseBRDate(dateStr) {
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(dateStr)) return null;
  const [d, m, y] = dateStr.split("/");
  return { isoDate: `${y}-${m}-${d}` };
}

function parseBRDateOrRange(input) {
  const parts = input.split(" a ");
  if (parts.length === 1) {
    const d = parseBRDate(parts[0]);
    if (!d) return null;
    return { label: parts[0], startIso: d.isoDate, endIso: d.isoDate };
  }
  if (parts.length === 2) {
    const s = parseBRDate(parts[0]);
    const e = parseBRDate(parts[1]);
    if (!s || !e) return null;
    return { label: input, startIso: s.isoDate, endIso: e.isoDate };
  }
  return null;
}

function toUtcRangeFromFortalezaInput(input) {
  const parsed = parseBRDateOrRange(input);
  const start = new Date(`${parsed.startIso}T00:00:00-03:00`).toISOString();
  const end = new Date(`${parsed.endIso}T23:59:59-03:00`).toISOString();
  return { label: parsed.label, start, end };
}

async function fetchJson(url) {
  const r = await fetch(url);
  return r.json();
}

async function buscarOddsPorPeriodoBR(periodInput, sportKey) {
  const { start, end } = toUtcRangeFromFortalezaInput(periodInput);

  const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds?apiKey=${oddsApiKey}&regions=eu&markets=h2h,totals&commenceTimeFrom=${start}&commenceTimeTo=${end}`;
  return fetchJson(url);
}

async function buscarLigasSoccerAtivas() {
  const url = `https://api.the-odds-api.com/v4/sports?apiKey=${oddsApiKey}`;
  const sports = await fetchJson(url);

  return sports
    .filter(s => s.key.startsWith("soccer_"))
    .map(s => ({ key: s.key, label: s.title }));
}

function resumirJogos(odds) {
  return odds.map(j => ({
    jogo: `${j.home_team} x ${j.away_team}`,
    horario: formatDateBR(j.commence_time),
    liga: "",
    bookmakers_count: j.bookmakers?.length || 0,
    totals_lines: j.bookmakers?.[0]?.markets?.find(m => m.key === "totals")?.outcomes || []
  }));
}

// ================= NOVAS FUNÇÕES =================

function getMultipleLeagueChoices(input, leagueOptions) {
  const parts = input.split(",").map(p => p.trim());
  return parts
    .map(p => leagueOptions[Number(p) - 1])
    .filter(Boolean);
}

function gerarScoreGlobal(jogo) {
  const linha = jogo.totals_lines?.filter(o => o.point === 2.5);
  if (!linha || linha.length < 2) return null;

  const over = linha.find(o => o.name === "Over");
  const under = linha.find(o => o.name === "Under");

  if (!over || !under) return null;

  let score = 0;
  const prob = (1 / over.price) / ((1 / over.price) + (1 / under.price));

  if (prob > 0.6) score += 30;
  if (over.price >= 1.5 && over.price <= 1.8) score += 30;
  if (Math.abs(over.price - under.price) < 0.3) score += 20;
  if (jogo.bookmakers_count >= 5) score += 20;

  return {
    score,
    mercado: "Over 2.5",
    odd: over.price
  };
}

function gerarTop50Global(jogos) {
  return jogos
    .map(j => {
      const s = gerarScoreGlobal(j);
      if (!s) return null;
      return { ...j, ...s };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, 50);
}

function formatarTopGlobal(lista) {
  let txt = "🔥 TOP 50 OPORTUNIDADES\n\n";

  lista.forEach((j, i) => {
    txt += `${i + 1}. ${j.jogo}\n🏆 ${j.liga}\n⏰ ${j.horario}\n📊 ${j.score}%\n💰 ${j.odd}\n\n`;
  });

  return txt;
}

// ================= BOT =================

bot.onText(/\/start/, msg => {
  bot.sendMessage(msg.chat.id, "Use /analise");
});

bot.onText(/\/analise/, msg => {
  pendingRequests.set(msg.chat.id, { step: "period" });
  bot.sendMessage(msg.chat.id, "Digite a data:");
});

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  const pending = pendingRequests.get(chatId);

  if (!pending) return;

  if (pending.step === "period") {
    pendingRequests.set(chatId, { step: "league", period: text });

    const ligas = await buscarLigasSoccerAtivas();

    pendingRequests.get(chatId).ligas = ligas;

    let lista = ligas.map((l, i) => `${i + 1}. ${l.label}`).join("\n");

    bot.sendMessage(chatId, "Escolha ligas (ex: 1,3,5)\n\n" + lista);
    return;
  }

  if (pending.step === "league") {
    const ligas = pending.ligas;
    const selecionadas = getMultipleLeagueChoices(text, ligas);

    let jogos = [];

    for (const liga of selecionadas) {
      const odds = await buscarOddsPorPeriodoBR(pending.period, liga.key);
      const js = resumirJogos(odds).map(j => ({ ...j, liga: liga.label }));
      jogos.push(...js);
    }

    const top = gerarTop50Global(jogos);
    const txt = formatarTopGlobal(top);

    bot.sendMessage(chatId, txt);

    pendingRequests.delete(chatId);
  }
});

console.log("🔥 Bot rodando com TOP 50 global");
