import TelegramBot from "node-telegram-bot-api";

const telegramToken = process.env.TELEGRAM_TOKEN;
const oddsApiKey = process.env.ODDS_API_KEY;

if (!telegramToken) throw new Error("Falta TELEGRAM_TOKEN");
if (!oddsApiKey) throw new Error("Falta ODDS_API_KEY");

const bot = new TelegramBot(telegramToken, { polling: true });

// =========================
// UTIL
// =========================

function formatDateBR(isoDate) {
  return new Date(isoDate).toLocaleString("pt-BR", {
    timeZone: "America/Fortaleza",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function fetchJson(url) {
  const res = await fetch(url);
  return res.json();
}

// =========================
// BUSCAR DADOS
// =========================

async function buscarLigas() {
  const url = `https://api.the-odds-api.com/v4/sports?apiKey=${oddsApiKey}`;
  const data = await fetchJson(url);

  return data
    .filter(s => s.key.startsWith("soccer_"))
    .filter(s => !s.key.endsWith("_winner"));
}

async function buscarJogosLiga(ligaKey) {
  const url = `https://api.the-odds-api.com/v4/sports/${ligaKey}/odds/?apiKey=${oddsApiKey}&regions=eu&markets=h2h,totals`;

  try {
    return await fetchJson(url);
  } catch {
    return [];
  }
}

// =========================
// PROCESSAMENTO
// =========================

function resumirJogo(game) {
  if (!game.bookmakers?.length) return null;

  const totals = game.bookmakers[0].markets.find(m => m.key === "totals");
  if (!totals) return null;

  const linha25 = totals.outcomes.filter(o => o.point === 2.5);
  if (linha25.length < 2) return null;

  const over = linha25.find(o => o.name === "Over");
  const under = linha25.find(o => o.name === "Under");

  if (!over || !under) return null;

  return {
    jogo: `${game.home_team} x ${game.away_team}`,
    horario: formatDateBR(game.commence_time),
    data: new Date(game.commence_time),
    oddOver: over.price,
    oddUnder: under.price,
    casa: game.bookmakers[0].title,
    casas: game.bookmakers.length
  };
}

// =========================
// FILTROS
// =========================

function apenasPreJogo(jogos) {
  const agora = new Date();
  return jogos.filter(j => j.data > agora);
}

function filtroQualidade(jogo) {
  return jogo.casas >= 5 && jogo.oddOver && jogo.oddUnder;
}

// =========================
// SCORE PROFISSIONAL
// =========================

function calcularScore(jogo) {
  let score = 0;

  const prob = (1 / jogo.oddOver) / ((1 / jogo.oddOver) + (1 / jogo.oddUnder));

  if (prob > 0.60) score += 25;
  if (prob > 0.65) score += 15;
  if (prob > 0.70) score += 10;

  if (jogo.oddOver >= 1.55 && jogo.oddOver <= 1.80) score += 25;

  const diff = Math.abs(jogo.oddOver - jogo.oddUnder);
  if (diff < 0.30) score += 20;

  if (jogo.casas >= 10) score += 20;

  return Math.min(score, 95);
}

// =========================
// SCAN GLOBAL
// =========================

async function scanGlobal() {
  const ligas = await buscarLigas();

  let todos = [];

  for (const liga of ligas) {
    const jogos = await buscarJogosLiga(liga.key);

    const processados = jogos
      .map(resumirJogo)
      .filter(Boolean)
      .map(j => ({ ...j, liga: liga.title }));

    todos.push(...processados);
  }

  const pre = apenasPreJogo(todos);

  const analisados = pre
    .filter(filtroQualidade)
    .map(j => ({
      ...j,
      score: calcularScore(j)
    }))
    .filter(j => j.score >= 70)
    .sort((a, b) => b.score - a.score)
    .slice(0, 50);

  return {
    total: todos.length,
    selecionados: analisados
  };
}

// =========================
// FORMATAR
// =========================

function formatarMensagem(resultado) {
  let texto = `🔥 TOP 50 PRÉ-JOGOS DO DIA\n\n`;
  texto += `📊 Jogos analisados: ${resultado.total}\n\n`;

  resultado.selecionados.forEach((j, i) => {
    texto += [
      `${i + 1}. ${j.jogo}`,
      `🏆 ${j.liga}`,
      `⏰ ${j.horario}`,
      `📊 ${j.score}%`,
      `🎯 Over 2.5`,
      `💰 ${j.oddOver}`,
      "",
    ].join("\n");
  });

  return texto;
}

async function sendLongMessage(chatId, text) {
  const chunk = 4000;
  for (let i = 0; i < text.length; i += chunk) {
    await bot.sendMessage(chatId, text.slice(i, i + chunk));
  }
}

// =========================
// TELEGRAM
// =========================

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "🤖 Tipster ativo\n\nComandos:\n/scan - ranking global do dia"
  );
});

bot.onText(/\/scan/, async (msg) => {
  const chatId = msg.chat.id;

  await bot.sendMessage(chatId, "🌍 Escaneando todos os jogos...");

  try {
    const resultado = await scanGlobal();

    await bot.sendMessage(chatId, "🧠 Aplicando filtro de precisão...");

    const texto = formatarMensagem(resultado);

    await sendLongMessage(chatId, texto);

  } catch (e) {
    console.log(e);
    bot.sendMessage(chatId, "❌ Erro ao executar scan.");
  }
});

console.log("Bot rodando com SCAN GLOBAL + PRECISÃO...");
