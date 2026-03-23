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

const pendingRequests = new Map();
// chatId -> {
//   type: "analise" | "surebet",
//   step: "date" | "league",
//   dateStr?: string,
//   leagueOptions?: [{ key, label, count }]
// }

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

function parseBRDate(dateStr) {
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(dateStr)) return null;

  const [dayStr, monthStr, yearStr] = dateStr.split("/");
  const day = Number(dayStr);
  const month = Number(monthStr);
  const year = Number(yearStr);

  if (!day || !month || !year) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;

  const testDate = new Date(Date.UTC(year, month - 1, day));
  const valid =
    testDate.getUTCFullYear() === year &&
    testDate.getUTCMonth() === month - 1 &&
    testDate.getUTCDate() === day;

  if (!valid) return null;

  const isoDate = `${yearStr}-${monthStr}-${dayStr}`;
  return { isoDate, dayStr, monthStr, yearStr };
}

function isPastDateBR(dateStr) {
  const parsed = parseBRDate(dateStr);
  if (!parsed) return true;
  return parsed.isoDate < todayInFortalezaISO();
}

function toUtcRangeFromFortalezaDateBR(dateStr) {
  const parsed = parseBRDate(dateStr);
  if (!parsed) throw new Error("Data inválida");

  const startDate = new Date(`${parsed.isoDate}T00:00:00-03:00`);
  const endDate = new Date(`${parsed.isoDate}T23:59:59-03:00`);

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

async function fetchJson(url, label = "REQUEST") {
  const response = await fetch(url);
  const rawText = await response.text();

  if (!response.ok) {
    throw new Error(`${label} ${response.status}: ${rawText}`);
  }

  try {
    return JSON.parse(rawText);
  } catch {
    throw new Error(`${label}_JSON_INVALID: ${rawText}`);
  }
}

async function buscarOddsPorDataBR(dateStr, selectedSportKey, lightweight = false) {
  const { start, end } = toUtcRangeFromFortalezaDateBR(dateStr);

  const params = new URLSearchParams({
    apiKey: oddsApiKey,
    regions: lightweight ? "eu" : "eu,uk,us",
    markets: lightweight ? "h2h" : "h2h,totals",
    oddsFormat: "decimal",
    commenceTimeFrom: start,
    commenceTimeTo: end,
  });

  const url = `https://api.the-odds-api.com/v4/sports/${selectedSportKey}/odds?${params.toString()}`;

  console.log("Buscando odds:", url.replace(oddsApiKey, "***"));

  return fetchJson(url, "ODDS_API_ERROR");
}

async function buscarLigasSoccerAtivas() {
  const params = new URLSearchParams({
    apiKey: oddsApiKey,
  });

  const url = `https://api.the-odds-api.com/v4/sports?${params.toString()}`;
  console.log("Buscando esportes ativos...");

  const sports = await fetchJson(url, "SPORTS_API_ERROR");

  return (sports || [])
    .filter((item) => item?.key?.startsWith("soccer_"))
    .filter((item) => !item?.key?.endsWith("_winner"))
    .map((item) => ({
      key: item.key,
      label: item.title || item.key,
    }));
}

async function contarEventosLiga(dateStr, league) {
  try {
    const odds = await buscarOddsPorDataBR(dateStr, league.key, true);
    return {
      key: league.key,
      label: league.label,
      count: Array.isArray(odds) ? odds.length : 0,
    };
  } catch (error) {
    console.error(`ERRO_CONTAGEM_LIGA_${league.key}:`, error.message);
    return {
      key: league.key,
      label: league.label,
      count: 0,
    };
  }
}

async function buscarLigasComEventosNaData(dateStr) {
  const activeLeagues = await buscarLigasSoccerAtivas();
  const results = [];
  const batchSize = 5;

  for (let i = 0; i < activeLeagues.length; i += batchSize) {
    const batch = activeLeagues.slice(i, i + batchSize);

    const batchResults = await Promise.all(
      batch.map((league) => contarEventosLiga(dateStr, league))
    );

    results.push(...batchResults);
  }

  return results
    .filter((item) => item.count > 0)
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.label.localeCompare(b.label, "pt-BR");
    });
}

function buildLeagueMessages(leagueOptions) {
  const lines = leagueOptions.map(
    (item, index) => `${index + 1}. ${item.label} (${item.count}) — ${item.key}`
  );

  const chunks = [];
  let current =
    "⚽ Escolha o campeonato.\nResponda com o número da liga desejada.\n\n";

  for (const line of lines) {
    if ((current + line + "\n").length > 3500) {
      chunks.push(current.trim());
      current = "";
    }
    current += `${line}\n`;
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks;
}

async function sendLeagueList(chatId, leagueOptions) {
  const messages = buildLeagueMessages(leagueOptions);
  for (const msg of messages) {
    await bot.sendMessage(chatId, msg);
  }
}

function getLeagueChoice(input, leagueOptions) {
  const text = input.trim();

  if (/^\d+$/.test(text)) {
    const index = Number(text) - 1;
    if (index >= 0 && index < leagueOptions.length) {
      return leagueOptions[index];
    }
  }

  const direct = leagueOptions.find(
    (item) => item.key.toLowerCase() === text.toLowerCase()
  );

  return direct || null;
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
        price: Number(outcome.price),
      };

      if (outcome.name === homeTeam) {
        if (!best.home || item.price > best.home.price) best.home = item;
      } else if (outcome.name === awayTeam) {
        if (!best.away || item.price > best.away.price) best.away = item;
      } else if (
        outcome.name?.toLowerCase() === "draw" ||
        outcome.name?.toLowerCase() === "empate"
      ) {
        if (!best.draw || item.price > best.draw.price) best.draw = item;
      }
    }
  }

  return best;
}

function getBestTotalsByLine(bookmakers) {
  const linesMap = new Map();

  for (const bookmaker of bookmakers || []) {
    const market = (bookmaker.markets || []).find((m) => m.key === "totals");
    if (!market) continue;

    for (const outcome of market.outcomes || []) {
      const side = outcome.name?.toLowerCase();
      const point = outcome.point;

      if (
        (side !== "over" && side !== "under") ||
        point === undefined ||
        point === null
      ) {
        continue;
      }

      const key = String(point);

      if (!linesMap.has(key)) {
        linesMap.set(key, {
          point,
          best_over: null,
          best_under: null,
        });
      }

      const line = linesMap.get(key);

      const entry = {
        bookmaker: bookmaker.title,
        name: outcome.name,
        price: Number(outcome.price),
        point: outcome.point,
      };

      if (side === "over") {
        if (!line.best_over || entry.price > line.best_over.price) {
          line.best_over = entry;
        }
      }

      if (side === "under") {
        if (!line.best_under || entry.price > line.best_under.price) {
          line.best_under = entry;
        }
      }
    }
  }

  const lines = Array.from(linesMap.values()).map((line) => {
    const balanceScore =
      line.best_over && line.best_under
        ? Math.abs(line.best_over.price - line.best_under.price)
        : 999;

    const distanceFrom25 =
      typeof line.point === "number" ? Math.abs(line.point - 2.5) : 999;

    return {
      point: line.point,
      best_over: line.best_over,
      best_under: line.best_under,
      balanceScore,
      distanceFrom25,
    };
  });

  lines.sort((a, b) => {
    if (a.balanceScore !== b.balanceScore) {
      return a.balanceScore - b.balanceScore;
    }
    return a.distanceFrom25 - b.distanceFrom25;
  });

  return lines.slice(0, 3).map((line) => ({
    point: line.point,
    best_over: line.best_over,
    best_under: line.best_under,
  }));
}

function resumirJogos(oddsData) {
  return (oddsData || []).slice(0, 30).map((game) => {
    const bestH2H = getBestH2H(game.bookmakers, game.home_team, game.away_team);
    const totalsLines = getBestTotalsByLine(game.bookmakers);

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
      totals_lines: totalsLines,
    };
  });
}

function calcularSurebetH2H(jogo) {
  const home = jogo.h2h?.mandante;
  const draw = jogo.h2h?.empate;
  const away = jogo.h2h?.visitante;

  if (!home || !draw || !away) return null;
  if (!home.price || !draw.price || !away.price) return null;

  const somaInversos =
    1 / Number(home.price) +
    1 / Number(draw.price) +
    1 / Number(away.price);

  if (somaInversos >= 1) return null;

  const margem = (1 - somaInversos) * 100;

  return {
    jogo: jogo.jogo,
    horario: jogo.horario,
    somaInversos,
    margem,
    selecoes: {
      mandante: home,
      empate: draw,
      visitante: away,
    },
  };
}

function calcularDistribuicaoStakes(oddHome, oddDraw, oddAway, totalStake = 100) {
  const invHome = 1 / oddHome;
  const invDraw = 1 / oddDraw;
  const invAway = 1 / oddAway;
  const soma = invHome + invDraw + invAway;

  const stakeHome = (totalStake * invHome) / soma;
  const stakeDraw = (totalStake * invDraw) / soma;
  const stakeAway = (totalStake * invAway) / soma;

  const retornoHome = stakeHome * oddHome;
  const retornoDraw = stakeDraw * oddDraw;
  const retornoAway = stakeAway * oddAway;

  const retornoGarantido = Math.min(retornoHome, retornoDraw, retornoAway);
  const lucroGarantido = retornoGarantido - totalStake;

  return {
    stakeHome,
    stakeDraw,
    stakeAway,
    retornoGarantido,
    lucroGarantido,
  };
}

function formatMoneyBR(value) {
  return Number(value).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

function formatPercent(value) {
  return `${Number(value).toFixed(2)}%`;
}

function montarTextoSurebets(surebets, dateStr, selectedSportKey, selectedLeagueLabel) {
  if (!surebets.length) {
    return [
      `📅 Data analisada: ${dateStr}`,
      `🏆 Liga: ${selectedLeagueLabel} (${selectedSportKey})`,
      "",
      "Nenhuma surebet H2H encontrada nesta data.",
      "",
      "Isso significa que, com os jogos e odds disponíveis, não houve combinação de mandante/empate/visitante com soma dos inversos menor que 1.",
    ].join("\n");
  }

  let texto = [
    `📅 Data analisada: ${dateStr}`,
    `🏆 Liga: ${selectedLeagueLabel} (${selectedSportKey})`,
    `✅ Surebets encontradas: ${surebets.length}`,
    "",
  ].join("\n");

  surebets.forEach((item, index) => {
    const home = item.selecoes.mandante;
    const draw = item.selecoes.empate;
    const away = item.selecoes.visitante;

    const stakes = calcularDistribuicaoStakes(
      home.price,
      draw.price,
      away.price,
      100
    );

    texto += [
      `#${index + 1} ${item.jogo}`,
      `Horário: ${item.horario}`,
      `Margem de arbitragem: ${formatPercent(item.margem)}`,
      "",
      `Mandante: ${home.name} @ ${home.price} | Casa: ${home.bookmaker}`,
      `Empate: ${draw.name} @ ${draw.price} | Casa: ${draw.bookmaker}`,
      `Visitante: ${away.name} @ ${away.price} | Casa: ${away.bookmaker}`,
      "",
      `Exemplo de divisão para ${formatMoneyBR(100)} total:`,
      `- Mandante: ${formatMoneyBR(stakes.stakeHome)}`,
      `- Empate: ${formatMoneyBR(stakes.stakeDraw)}`,
      `- Visitante: ${formatMoneyBR(stakes.stakeAway)}`,
      `Retorno garantido estimado: ${formatMoneyBR(stakes.retornoGarantido)}`,
      `Lucro garantido estimado: ${formatMoneyBR(stakes.lucroGarantido)}`,
      "",
      "Observação: confirme a odd no momento da execução, pois a arbitragem pode desaparecer rapidamente.",
      "",
      "----------------------------------------",
      "",
    ].join("\n");
  });

  return texto.trim();
}

bot.onText(/\/start/, async (msg) => {
  await bot.sendMessage(
    msg.chat.id,
    [
      "🤖 Tipster365 ativo.",
      "",
      "Comandos disponíveis:",
      "/analise - pede data e depois mostra ligas com quantidade de jogos",
      "/surebet - pede data e depois mostra ligas com quantidade de jogos",
      "/cancelar - cancelar solicitação atual",
      "",
      "Formato da data: dd/mm/aaaa",
      "Exemplo: 22/03/2026",
    ].join("\n")
  );
});

bot.onText(/\/cancelar/, async (msg) => {
  pendingRequests.delete(msg.chat.id);
  await bot.sendMessage(msg.chat.id, "✅ Solicitação cancelada.");
});

bot.onText(/\/analise/, async (msg) => {
  pendingRequests.set(msg.chat.id, { type: "analise", step: "date" });
  await bot.sendMessage(
    msg.chat.id,
    "📅 Me envie a data que você quer analisar no formato dd/mm/aaaa.\nExemplo: 22/03/2026"
  );
});

bot.onText(/\/surebet/, async (msg) => {
  pendingRequests.set(msg.chat.id, { type: "surebet", step: "date" });
  await bot.sendMessage(
    msg.chat.id,
    "📅 Me envie a data para procurar surebets no formato dd/mm/aaaa.\nExemplo: 22/03/2026"
  );
});

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  const pending = pendingRequests.get(chatId);

  if (!pending) return;
  if (text.startsWith("/")) return;

  if (pending.step === "date") {
    const parsed = parseBRDate(text);

    if (!parsed) {
      await bot.sendMessage(
        chatId,
        "❌ Data inválida. Use o formato dd/mm/aaaa.\nExemplo: 22/03/2026"
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

    await bot.sendMessage(
      chatId,
      `⏳ Levantando ligas com jogos em ${text}...`
    );

    try {
      const leagueOptions = await buscarLigasComEventosNaData(text);

      if (!leagueOptions.length) {
        pendingRequests.delete(chatId);
        await bot.sendMessage(
          chatId,
          `Nenhuma liga de futebol com jogos foi encontrada para ${text}.`
        );
        return;
      }

      pendingRequests.set(chatId, {
        type: pending.type,
        step: "league",
        dateStr: text,
        leagueOptions,
      });

      await bot.sendMessage(
        chatId,
        `✅ Encontrei ${leagueOptions.length} liga(s) com jogos em ${text}.`
      );
      await sendLeagueList(chatId, leagueOptions);
    } catch (error) {
      pendingRequests.delete(chatId);
      console.error("ERRO_LISTA_LIGAS:", error);
      await bot.sendMessage(
        chatId,
        "❌ Erro ao levantar as ligas da data informada. Veja os logs do Railway para o detalhe."
      );
    }

    return;
  }

  if (pending.step === "league") {
    const chosenLeague = getLeagueChoice(text, pending.leagueOptions || []);

    if (!chosenLeague) {
      await bot.sendMessage(
        chatId,
        "❌ Campeonato inválido. Responda com o número da lista."
      );
      return;
    }

    pendingRequests.delete(chatId);

    const selectedSportKey = chosenLeague.key;
    const selectedLeagueLabel = chosenLeague.label;
    const selectedDate = pending.dateStr;

    let jogos = [];

    try {
      await bot.sendMessage(
        chatId,
        `⏳ Buscando jogos reais para ${selectedDate} em ${selectedLeagueLabel}...`
      );

      const odds = await buscarOddsPorDataBR(selectedDate, selectedSportKey, false);
      jogos = resumirJogos(odds);

      await bot.sendMessage(
        chatId,
        `📋 Encontrei ${jogos.length} jogo(s) para ${selectedDate} em ${selectedLeagueLabel}.`
      );

      if (!jogos.length) {
        await bot.sendMessage(
          chatId,
          `Nenhum jogo encontrado para ${selectedDate} em ${selectedLeagueLabel} (${selectedSportKey}).`
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

    if (pending.type === "surebet") {
      try {
        await bot.sendMessage(chatId, "🔎 Calculando surebets H2H...");

        const surebets = jogos
          .map(calcularSurebetH2H)
          .filter(Boolean)
          .sort((a, b) => b.margem - a.margem);

        const textoSurebets = montarTextoSurebets(
          surebets,
          selectedDate,
          selectedSportKey,
          selectedLeagueLabel
        );

        await sendLongMessage(chatId, textoSurebets);
      } catch (error) {
        console.error("ERRO_SUREBET:", error);
        await bot.sendMessage(
          chatId,
          "❌ Erro ao calcular surebets. Veja os logs do Railway para o detalhe."
        );
      }

      return;
    }

    if (pending.type === "analise") {
      try {
        await bot.sendMessage(chatId, "🤖 Gerando análise com IA...");

        const prompt = `
Você é um analista profissional de apostas esportivas.

Analise SOMENTE os dados reais fornecidos abaixo.
Considere apenas os mercados H2H e OVER/UNDER gols.
Não invente jogos, odds, linhas, horários, estatísticas externas ou contexto não fornecido.
Se os dados forem insuficientes, diga isso claramente.

Objetivo:
Selecionar as melhores entradas do dia solicitado com base em:
- solidez do mercado
- coerência entre linha e odd
- favoritismo mais claro no H2H
- linhas de gols mais consistentes no Over/Under
- evitar entradas especulativas ou forçadas

Regras obrigatórias:
- Retorne no máximo 5 entradas.
- Não force 5 entradas se o cenário não justificar.
- Pode retornar 3 ou 4 entradas, se forem as únicas realmente sólidas.
- Evite repetir o mesmo jogo excessivamente.
- Use no máximo 2 entradas por jogo.
- Em OVER/UNDER, cite a linha explicitamente. Exemplo: Over 2.5 ou Under 2.5.
- Ordene da melhor para a menos forte.
- Não use justificativas genéricas como "odd interessante" ou "bom valor" sem explicar o motivo com base nos dados fornecidos.
- Seja objetivo e específico.

Retorne exatamente neste formato:

1. Data analisada
2. Resumo curto do cenário do dia
3. Top entradas do dia

Para cada entrada, use exatamente:
- Ranking:
- Jogo:
- Horário:
- Mercado:
- Entrada:
- Odd:
- Casa:
- Justificativa curta:

4. Observação final de risco

Data analisada: ${selectedDate}
Liga: ${selectedLeagueLabel}
Sport key: ${selectedSportKey}

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
    }
  }
});

console.log("Bot iniciado com seleção de data + ligas com quantidade de eventos.");
