import TelegramBot from "node-telegram-bot-api";
import OpenAI from "openai";

const telegramToken = process.env.TELEGRAM_TOKEN;
const openaiKey = process.env.OPENAI_API_KEY;
const oddsApiKey = process.env.ODDS_API_KEY;

// Você pode trocar depois para outro esporte.
// Exemplos:
// soccer_epl
// soccer_brazil_campeonato
// basketball_nba
const sportKey = process.env.SPORT_KEY || "soccer_epl";

if (!telegramToken) throw new Error("Falta a variável TELEGRAM_TOKEN");
if (!openaiKey) throw new Error("Falta a variável OPENAI_API_KEY");
if (!oddsApiKey) throw new Error("Falta a variável ODDS_API_KEY");

const bot = new TelegramBot(telegramToken, { polling: true });
const client = new OpenAI({ apiKey: openaiKey });

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

async function sendLongMessage(chatId, text) {
  const chunkSize = 3500;
  if (!text) return;

  for (let i = 0; i < text.length; i += chunkSize) {
    const chunk = text.slice(i, i + chunkSize);
    await bot.sendMessage(chatId, chunk);
  }
}

async function buscarOddsReais() {
  const url =
    `https://api.the-odds-api.com/v4/sports/${sportKey}/odds` +
    `?apiKey=${oddsApiKey}` +
    `&regions=eu` +
    `&markets=h2h` +
    `&oddsFormat=decimal`;

  const response = await fetch(url);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Erro API Odds: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  return data;
}

function resumirJogos(oddsData) {
  return oddsData.slice(0, 10).map((game) => {
    const bookmaker = game.bookmakers?.[0];
    const market = bookmaker?.markets?.[0];

    const outcomes =
      market?.outcomes?.map((outcome) => ({
        name: outcome.name,
        price: outcome.price,
      })) || [];

    return {
      sport: game.sport_title || "N/D",
      commence_time: game.commence_time,
      home_team: game.home_team || "Mandante",
      away_team: game.away_team || "Visitante",
      bookmaker: bookmaker?.title || "N/D",
      odds: outcomes,
    };
  });
}

function formatarJogosTexto(jogos) {
  if (!jogos.length) return "Nenhum jogo encontrado.";

  return jogos
    .map((jogo, index) => {
      const oddsTexto = jogo.odds.length
        ? jogo.odds.map((o) => `${o.name}: ${o.price}`).join(" | ")
        : "Sem odds disponíveis";

      return [
        `${index + 1}. ${jogo.home_team} x ${jogo.away_team}`,
        `Esporte: ${jogo.sport}`,
        `Horário: ${formatDateBR(jogo.commence_time)}`,
        `Casa: ${jogo.bookmaker}`,
        `Odds: ${oddsTexto}`,
      ].join("\n");
    })
    .join("\n\n");
}

bot.onText(/\/start/, async (msg) => {
  const texto = [
    "🤖 Tipster365 ativo.",
    "",
    "Comandos disponíveis:",
    "/jogos - lista jogos e odds reais",
    "/analise - análise com base em dados reais",
    "/bilhete - modelo de bilhete com base nos jogos reais",
  ].join("\n");

  await bot.sendMessage(msg.chat.id, texto);
});

bot.onText(/\/jogos/, async (msg) => {
  const chatId = msg.chat.id;

  try {
    await bot.sendMessage(chatId, "⏳ Buscando jogos reais...");

    const odds = await buscarOddsReais();
    const jogos = resumirJogos(odds);

    if (!jogos.length) {
      await bot.sendMessage(chatId, "Nenhum jogo encontrado no momento.");
      return;
    }

    const texto = `📋 Jogos encontrados para ${sportKey}:\n\n${formatarJogosTexto(jogos)}`;
    await sendLongMessage(chatId, texto);
  } catch (error) {
    console.error("Erro /jogos:", error);
    await bot.sendMessage(chatId, "❌ Erro ao buscar jogos reais.");
  }
});

bot.onText(/\/analise/, async (msg) => {
  const chatId = msg.chat.id;

  try {
    await bot.sendMessage(chatId, "⏳ Buscando jogos reais e gerando análise...");

    const odds = await buscarOddsReais();
    const jogos = resumirJogos(odds);

    if (!jogos.length) {
      await bot.sendMessage(chatId, "Nenhum jogo encontrado para análise.");
      return;
    }

    const prompt = `
Você é um analista esportivo profissional.

Regras obrigatórias:
- Use SOMENTE os dados reais fornecidos abaixo.
- Não invente jogos, odds, horários, mercados ou resultados.
- Se os dados forem insuficientes, diga isso claramente.
- Responda em português do Brasil.
- Seja objetivo, claro e organizado.
- Não afirme certeza de ganho.
- Trate a resposta como análise probabilística e educacional.

Quero o seguinte formato:

1. Cenário geral do dia
2. Mercados mais conservadores observáveis
3. Top 5 oportunidades mais conservadoras
4. Top 3 oportunidades mais agressivas
5. 1 bilhete conservador
6. 1 bilhete agressivo
7. Aviso final de risco

Dados reais:
${JSON.stringify(jogos, null, 2)}
`;

    const response = await client.responses.create({
      model: "gpt-5.4",
      input: prompt,
    });

    const texto = response.output_text || "Não consegui gerar a análise.";
    await sendLongMessage(chatId, texto);
  } catch (error) {
    console.error("Erro /analise:", error);
    await bot.sendMessage(chatId, "❌ Erro ao gerar análise com dados reais.");
  }
});

bot.onText(/\/bilhete/, async (msg) => {
  const chatId = msg.chat.id;

  try {
    await bot.sendMessage(chatId, "⏳ Montando bilhete com base nos jogos reais...");

    const odds = await buscarOddsReais();
    const jogos = resumirJogos(odds);

    if (!jogos.length) {
      await bot.sendMessage(chatId, "Nenhum jogo encontrado para montar o bilhete.");
      return;
    }

    const prompt = `
Você é um analista esportivo profissional.

Regras obrigatórias:
- Use SOMENTE os dados reais fornecidos.
- Não invente jogos, odds, horários, mercados ou resultados.
- Se os dados forem insuficientes, diga isso claramente.
- Responda em português do Brasil.
- Seja direto, objetivo e profissional.
- Não trate como garantia de ganho.

Monte:
1. Bilhete conservador
2. Faixa de odds sugerida
3. Gestão de banca sugerida
4. Bilhete mais agressivo
5. Aviso final

Dados reais:
${JSON.stringify(jogos, null, 2)}
`;

    const response = await client.responses.create({
      model: "gpt-5.4",
      input: prompt,
    });

    const texto = response.output_text || "Não consegui gerar o bilhete.";
    await sendLongMessage(chatId, texto);
  } catch (error) {
    console.error("Erro /bilhete:", error);
    await bot.sendMessage(chatId, "❌ Erro ao gerar o bilhete com dados reais.");
  }
});

console.log(`Bot iniciado com polling ativo. Esporte atual: ${sportKey}`);
