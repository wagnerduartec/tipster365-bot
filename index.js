import TelegramBot from "node-telegram-bot-api";
import OpenAI from "openai";

const telegramToken = process.env.TELEGRAM_TOKEN;
const openaiKey = process.env.OPENAI_API_KEY;
const oddsApiKey = process.env.ODDS_API_KEY;
const sportKey = process.env.SPORT_KEY || "soccer_epl";

if (!telegramToken) throw new Error("Falta TELEGRAM_TOKEN");
if (!openaiKey) throw new Error("Falta OPENAI_API_KEY");
if (!oddsApiKey) throw new Error("Falta ODDS_API_KEY");

const bot = new TelegramBot(telegramToken, { polling: true });
const client = new OpenAI({ apiKey: openaiKey });

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

function isValidDateInputBR(dateStr) {
  return /^\d{2}\/\d{2}\/\d{4}$/.test(dateStr);
}

function parseBRDateToISO(dateStr) {
  const [day, month, year] = dateStr.split("/");
  return `${year}-${month}-${day}`;
}

function todayInFortalezaISO() {
  const now = new Date();

  const year = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Fortaleza",
    year: "numeric",
  }).format(now);

  const month = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Fortaleza",
    month: "2-digit",
  }).format(now);

  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Fortaleza",
    day: "2-digit",
  }).format(now);

  return `${year}-${month}-${day}`;
}

function isPastDateBR(dateStr) {
  const isoDate = parseBRDateToISO(dateStr);
  return isoDate < todayInFortalezaISO();
}

function toUtcRangeFromFortalezaDateBR(dateStr) {
  const isoDate = parseBRDateToISO(dateStr);

  const startDate = new Date(`${isoDate}T00:00:00-03:00`);
  const endDate = new Date(`${isoDate}T23:59:59-03:00`);

  const formatForOddsApi = (date) =>
    date.toISOString().replace(/\.\d{3}Z$/, "Z");

  return {
    start: formatForOddsApi(startDate),
    end: formatForOddsApi(endDate),
  };
}

async function sendLongMessage(chatId, text) {
  const chunkSize = 3500;
  if (!text) return;

  for (let i = 0; i < text.length; i += chunkSize) {
    await bot.sendMessage(chatId, text.slice(i, i + chunkSize));
  }
}

async function buscarOddsPorDataBR(dateStr) {
  const { start, end } = toUtcRangeFromFortalezaDateBR(dateStr);

  const params = new URLSearchParams({
    apiKey: oddsApiKey,
    regions: "eu,uk,us",
    markets: "h2h,totals",
    oddsFormat: "decimal",
    commenceTimeFrom: start,
    commenceTimeTo: end,
  });

  const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds?${params.toString()}`;

  console.log("Buscando odds:", url.replace(oddsApiKey, "***"));

  const response = await fetch(url);
  const rawText = await response.text();

  if (!response.ok) {
    throw new Error(`ODDS_API_ERROR ${response.status}: ${rawText}`);
  }

  let data;
  try {
    data = JSON.parse(rawText);
  } catch {
    throw new Error(`ODDS_API_JSON_INVALID: ${rawText}`);
  }

  return data;
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
        outcome.name?.toLowerCase() === "draw" ||
        outcome.name?.toLowerCase() === "empate"
      ) {
        if (!best.draw || outcome.price > best.draw.price) best.draw = item;
      }
    }
  }

  return best;
}

function getBestTotals(bookmakers) {
  const candidates = [];

  for (const bookmaker of bookmakers || []) {
    const market = (bookmaker.markets || []).find((m) => m.key === "totals");
    if (!market) continue;

    for (const outcome of market.outcomes || []) {
      if (
        outcome.name?.toLowerCase() === "over" ||
        outcome.name?.toLowerCase() === "under"
      ) {
        candidates.push({
          bookmaker: bookmaker.title,
          name: outcome.name,
          price: outcome.price,
          point: outcome.point,
        });
      }
    }
  }

  if (!candidates.length) {
    return { best_over: null, best_under: null };
  }

  const overs = candidates.filter((c) => c.name.toLowerCase() === "over");
  const unders = candidates.filter((c) => c.name.toLowerCase() === "under");

  const best_over = overs.sort((a, b) => b.price - a.price)[0] || null;
  const best_under = unders.sort((a, b) => b.price - a.price)[0] || null;

  return { best_over, best_under };
}

function resumirJogos(oddsData) {
  return (oddsData || []).slice(0, 20).map((game) => {
    const bestH2H = getBestH2H(game.bookmakers, game.home_team, game.away_team);
    const bestTotals = getBestTotals(game.bookmakers);

    return {
      jogo: `${game.home_team} x ${game.away_team}`,
      horario: formatDateBR(game.commence_time),
      home_team: game.home_team,
      away_team: game.away_team,
      bookmakers_count: (game.bookmakers || []).length,
      h2h: {
        mandante: bestH2H.home,
        empate: bestH2H.draw,
        visitante: bestH2H.away,
      },
      totals: bestTotals,
    };
  });
}

bot.onText(/\/start/, async (msg) => {
  await bot.sendMessage(
    msg.chat.id,
    [
      "🤖 Tipster365 ativo.",
      "",
      "Comandos disponíveis:",
      "/analise - pedir análise por data",
      "/cancelar - cancelar solicitação atual",
      "",
      "Formato da data: dd/mm/aaaa",
      "Exemplo: 21/03/2026",
    ].join("\n")
  );
});

bot.onText(/\/cancelar/, async (msg) => {
  pendingDateInput.delete(msg.chat.id);
  await bot.sendMessage(msg.chat.id, "✅ Solicitação cancelada.");
});

bot.onText(/\/analise/, async (msg) => {
  pendingDateInput.set(msg.chat.id, true);

  await bot.sendMessage(
    msg.chat.id,
    "📅 Me envie a data que você quer analisar no formato dd/mm/aaaa.\nExemplo: 21/03/2026"
  );
});

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();

  if (!pendingDateInput.get(chatId)) return;
  if (text.startsWith("/")) return;

  pendingDateInput.delete(chatId);

  if (!isValidDateInputBR(text)) {
    await bot.sendMessage(
      chatId,
      "❌ Data inválida. Use o formato dd/mm/aaaa.\nExemplo: 21/03/2026"
    );
    return;
  }

  if (isPastDateBR(text)) {
    await bot.sendMessage(
      chatId,
      "❌ Essa data está no passado. Nesta versão simples, eu analiso apenas hoje ou datas futuras."
    );
    return;
  }

  let jogos = [];

  try {
    await bot.sendMessage(chatId, `⏳ Buscando jogos reais para ${text}...`);

    const odds = await buscarOddsPorDataBR(text);
    jogos = resumirJogos(odds);

    if (!jogos.length) {
      await bot.sendMessage(
        chatId,
        `Nenhum jogo encontrado para ${text} em ${sportKey}.`
      );
      return;
    }
  } catch (error) {
    console.error("ERRO_ODDS:", error);
    await bot.sendMessage(
      chatId,
      "❌ Erro ao buscar os jogos da data informada. Veja os logs do Railway para o detalhe."
    );
    return;
  }

  try {
    await bot.sendMessage(chatId, "🤖 Gerando análise com IA...");

    const prompt = `
Você é um analista profissional de apostas esportivas.

Analise SOMENTE os dados reais abaixo.
Considere apenas os mercados H2H e OVER/UNDER gols.
Não invente jogos, odds, linhas, horários ou estatísticas externas.
Se os dados forem insuficientes, diga isso claramente.

Seu objetivo é retornar as 5 melhores entradas do dia solicitado, priorizando:
- coerência entre linha e odd
- mercados mais sólidos
- entradas menos forçadas
- consistência na leitura do cenário

Retorne exatamente neste formato:

1. Data analisada
2. Resumo curto do cenário do dia
3. Top 5 entradas do dia

Para cada entrada, use exatamente:
- Jogo:
- Horário:
- Mercado:
- Entrada:
- Odd:
- Casa:
- Justificativa curta:

4. Observação final de risco

Data analisada: ${text}
Esporte: ${sportKey}

Dados reais:
${JSON.stringify(jogos, null, 2)}
`;

    const response = await client.responses.create({
      model: "gpt-5.4",
      input: prompt,
    });

    const textoResposta =
      response.output_text || "Não foi possível gerar a análise.";

    await sendLongMessage(chatId, textoResposta);
  } catch (error) {
    console.error("ERRO_OPENAI:", error);
    await bot.sendMessage(
      chatId,
      "❌ Erro ao gerar a análise pela IA. Veja os logs do Railway para o detalhe."
    );
  }
});

console.log(`Bot iniciado. SPORT_KEY atual: ${sportKey}`);
