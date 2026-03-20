import TelegramBot from "node-telegram-bot-api";
import OpenAI from "openai";

const telegramToken = process.env.TELEGRAM_TOKEN;
const openaiKey = process.env.OPENAI_API_KEY;
const oddsApiKey = process.env.ODDS_API_KEY;
const sportKey = process.env.SPORT_KEY; // mantenha o que você já usa no Railway

if (!telegramToken) throw new Error("Falta a variável TELEGRAM_TOKEN");
if (!openaiKey) throw new Error("Falta a variável OPENAI_API_KEY");
if (!oddsApiKey) throw new Error("Falta a variável ODDS_API_KEY");
if (!sportKey) throw new Error("Falta a variável SPORT_KEY");

const bot = new TelegramBot(telegramToken, { polling: true });
const client = new OpenAI({ apiKey: openaiKey });

// Guarda quem está no fluxo de informar data
const pendingDateInput = new Map();

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

function isValidDateInput(dateStr) {
  return /^\d{4}-\d{2}-\d{2}$/.test(dateStr);
}

function toUtcRangeFromFortalezaDate(dateStr) {
  // Fortaleza = UTC-3, sem horário de verão
  const start = new Date(`${dateStr}T00:00:00-03:00`).toISOString();
  const end = new Date(`${dateStr}T23:59:59-03:00`).toISOString();
  return { start, end };
}

function isPastDate(dateStr) {
  const now = new Date();
  const todayFortaleza = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Fortaleza",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);

  return dateStr < todayFortaleza;
}

async function sendLongMessage(chatId, text) {
  const chunkSize = 3500;
  if (!text) return;

  for (let i = 0; i < text.length; i += chunkSize) {
    await bot.sendMessage(chatId, text.slice(i, i + chunkSize));
  }
}

async function buscarOddsPorData(dateStr) {
  const { start, end } = toUtcRangeFromFortalezaDate(dateStr);

  const url =
    `https://api.the-odds-api.com/v4/sports/${sportKey}/odds` +
    `?apiKey=${oddsApiKey}` +
    `&regions=eu` +
    `&markets=h2h,totals` +
    `&oddsFormat=decimal` +
    `&commenceTimeFrom=${encodeURIComponent(start)}` +
    `&commenceTimeTo=${encodeURIComponent(end)}`;

  const response = await fetch(url);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Erro API Odds: ${response.status} - ${errorText}`);
  }

  return await response.json();
}

function getBestH2H(bookmakers, homeTeam, awayTeam) {
  const best = {
    home: null,
    draw: null,
    away: null,
  };

  for (const bookmaker of bookmakers || []) {
    const market = (bookmaker.markets || []).find((m) => m.key === "h2h");
    if (!market) continue;

    for (const outcome of market.outcomes || []) {
      const item = {
        bookmaker: bookmaker.title,
        name: outcome.name,
        price: outcome.price,
      };

      if (outcome.name === homeTeam) {
        if (!best.home || outcome.price > best.home.price) best.home = item;
      } else if (outcome.name === awayTeam) {
        if (!best.away || outcome.price > best.away.price) best.away = item;
      } else if (
        outcome.name.toLowerCase() === "draw" ||
        outcome.name.toLowerCase() === "empate"
      ) {
        if (!best.draw || outcome.price > best.draw.price) best.draw = item;
      }
    }
  }

  return best;
}

function getBestTotals(bookmakers) {
  const best = {
    over: null,
    under: null,
  };

  for (const bookmaker of bookmakers || []) {
    const market = (bookmaker.markets || []).find((m) => m.key === "totals");
    if (!market) continue;

    for (const outcome of market.outcomes || []) {
      const item = {
        bookmaker: bookmaker.title,
        name: outcome.name,
        price: outcome.price,
        point: outcome.point,
      };

      if (outcome.name.toLowerCase() === "over") {
        if (!best.over || outcome.price > best.over.price) best.over = item;
      }

      if (outcome.name.toLowerCase() === "under") {
        if (!best.under || outcome.price > best.under.price) best.under = item;
      }
    }
  }

  return best;
}

function resumirJogos(oddsData) {
  return (oddsData || []).map((game) => {
    const bestH2H = getBestH2H(game.bookmakers, game.home_team, game.away_team);
    const bestTotals = getBestTotals(game.bookmakers);

    return {
      event_id: game.id,
      sport: game.sport_title,
      commence_time: game.commence_time,
      home_team: game.home_team,
      away_team: game.away_team,
      bookmakers_count: (game.bookmakers || []).length,
      h2h: bestH2H,
      totals: bestTotals,
    };
  });
}

bot.onText(/\/start/, async (msg) => {
  const texto = [
    "🤖 Tipster365 ativo.",
    "",
    "Comandos disponíveis:",
    "/analise - pede a data e retorna as 5 melhores entradas",
    "",
    "Formato da data: AAAA-MM-DD",
    "Exemplo: 2026-03-21",
  ].join("\n");

  await bot.sendMessage(msg.chat.id, texto);
});

bot.onText(/\/analise/, async (msg) => {
  pendingDateInput.set(msg.chat.id, true);

  await bot.sendMessage(
    msg.chat.id,
    "📅 Me envie a data que você quer analisar no formato AAAA-MM-DD.\nExemplo: 2026-03-21"
  );
});

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();

  if (!pendingDateInput.get(chatId)) return;
  if (text.startsWith("/")) return;

  pendingDateInput.delete(chatId);

  if (!isValidDateInput(text)) {
    await bot.sendMessage(
      chatId,
      "❌ Data inválida. Use o formato AAAA-MM-DD.\nExemplo: 2026-03-21"
    );
    return;
  }

  if (isPastDate(text)) {
    await bot.sendMessage(
      chatId,
      "❌ Essa data está no passado. Nesta versão simples, com o endpoint atual, eu consigo analisar hoje ou datas futuras. Para passado, a API histórica normalmente exige plano pago."
    );
    return;
  }

  try {
    await bot.sendMessage(chatId, `⏳ Buscando jogos e analisando ${text}...`);

    const odds = await buscarOddsPorData(text);
    const jogos = resumirJogos(odds);

    if (!jogos.length) {
      await bot.sendMessage(chatId, "Nenhum jogo encontrado para essa data.");
      return;
    }

    const prompt = `
Você é um analista profissional de apostas esportivas.

Tarefa:
Analisar SOMENTE os dados reais fornecidos abaixo e retornar as 5 melhores entradas do dia.

Regras obrigatórias:
- Use somente os mercados H2H e OVER/UNDER (totals).
- Não invente jogos, odds, linhas, horários ou mercados.
- Não invente contexto estatístico externo.
- Se os dados forem insuficientes, diga isso.
- Seja objetivo.
- Responda em português do Brasil.
- Considere como "melhores entradas" as opções mais sólidas e coerentes com as odds e linhas disponíveis.
- Se houver menos de 5 boas entradas, retorne apenas as que fizerem sentido.

Formato exato da resposta:
1. Data analisada
2. Resumo curto do cenário do dia
3. Top 5 entradas do dia

Para cada entrada, use este formato:
- Jogo:
- Horário:
- Mercado:
- Entrada:
- Odd:
- Casa:
- Justificativa curta:

4. Observação final de risco

Data solicitada: ${text}

Dados reais:
${JSON.stringify(jogos, null, 2)}
`;

    const response = await client.responses.create({
      model: "gpt-5.4",
      input: prompt,
    });

    const textoResposta =
      response.output_text || "Não consegui gerar a análise.";

    await sendLongMessage(chatId, textoResposta);
  } catch (error) {
    console.error("Erro no fluxo de data /analise:", error);
    await bot.sendMessage(
      chatId,
      "❌ Erro ao gerar a análise da data informada."
    );
  }
});

console.log(`Bot iniciado com polling ativo. SPORT_KEY atual: ${sportKey}`);
