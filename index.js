import TelegramBot from "node-telegram-bot-api";
import OpenAI from "openai";

const telegramToken = process.env.TELEGRAM_TOKEN;
const openaiKey = process.env.OPENAI_API_KEY;

if (!telegramToken || telegramToken === "COLOCAR_AQUI_SEU_TOKEN_TELEGRAM") {
  throw new Error("❌ Falta a variável TELEGRAM_TOKEN. Configure no Railway.");
}

if (!openaiKey || openaiKey === "COLOCAR_AQUI_SUA_CHAVE_OPENAI") {
  throw new Error("❌ Falta a variável OPENAI_API_KEY. Configure no Railway.");
}

const bot = new TelegramBot(telegramToken, { polling: true });
const client = new OpenAI({ apiKey: openaiKey });

console.log("✅ Tipster365 Bot iniciado com sucesso!");

// Comando /start
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  await bot.sendMessage(
    chatId,
    "🤖 Tipster365 ativo.\n\nComandos disponíveis:\n/analise - análise do dia\n/bilhete - bilhete resumido"
  );
});

// Comando /analise
bot.onText(/\/analise/, async (msg) => {
  const chatId = msg.chat.id;
  await bot.sendMessage(chatId, "⏳ Gerando análise...");

  try {
    const response = await client.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content:
            "Você é um analista de apostas esportivas profissional. Sempre deixe claro quando não tiver dados reais de partidas/odds. Entregue análises educacionais e estruturadas.",
        },
        {
          role: "user",
          content: `Gere uma análise de apostas esportivas em português do Brasil com a seguinte estrutura:

1. **Cenário geral do dia** - visão geral do mercado
2. **Mercados mais seguros para observar** - onde há melhor oportunidade
3. **5 ideias de entradas conservadoras** - apostas com menor risco
4. **3 ideias de entradas mais agressivas** - apostas com maior potencial
5. **1 bilhete conservador** - exemplo de aposta segura
6. **1 bilhete agressivo** - exemplo de aposta com maior risco
7. **Aviso de responsabilidade final** - disclaimer importante

IMPORTANTE: Não invente odds ao vivo confirmadas. Se não tiver dados reais, deixe isso claro. Seja direto, profissional e organizado.`,
        },
      ],
      max_tokens: 1500,
    });

    const texto =
      response.choices[0]?.message?.content ||
      "Não consegui gerar a análise.";
    const textoLimitado = texto.slice(0, 4096);

    await bot.sendMessage(chatId, textoLimitado);
  } catch (error) {
    console.error("❌ Erro /analise:", error.message);
    await bot.sendMessage(chatId, "❌ Erro ao gerar a análise.");
  }
});

// Comando /bilhete
bot.onText(/\/bilhete/, async (msg) => {
  const chatId = msg.chat.id;
  await bot.sendMessage(chatId, "⏳ Montando bilhete...");

  try {
    const response = await client.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content:
            "Você é um especialista em gestão de apostas esportivas. Sempre deixe claro quando estiver usando exemplos ilustrativos.",
        },
        {
          role: "user",
          content: `Monte um exemplo de bilhete esportivo em português do Brasil com a seguinte estrutura:

1. **Bilhete conservador** - exemplo com menor risco
2. **Faixa de odds sugerida** - range recomendado
3. **Gestão de banca** - como gerenciar o capital
4. **Aviso final** - disclaimer importante

IMPORTANTE: Não invente jogos ao vivo confirmados. Se não houver base real de odds, informe que é um modelo ilustrativo. Seja objetivo e prático.`,
        },
      ],
      max_tokens: 1000,
    });

    const texto =
      response.choices[0]?.message?.content ||
      "Não consegui gerar o bilhete.";
    const textoLimitado = texto.slice(0, 4096);

    await bot.sendMessage(chatId, textoLimitado);
  } catch (error) {
    console.error("❌ Erro /bilhete:", error.message);
    await bot.sendMessage(chatId, "❌ Erro ao gerar o bilhete.");
  }
});

// Tratamento de erros gerais
bot.on("error", (error) => {
  console.error("❌ Erro no bot:", error);
});

console.log("🚀 Bot aguardando mensagens...");
