import TelegramBot from "node-telegram-bot-api";
import { OpenAI } from "openai";
import dotenv from "dotenv";
import express from "express";

dotenv.config();

const app = express();
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Running on Port ${PORT}`);
});

// Load environment variables
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN!;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;

// Initialize Telegram bot
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// Initialize OpenAI API
const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

// Helper function to generate Bible counseling response
async function getBiblicalCounsel(prompt: string): Promise<string> {
  const systemMessage = `You are a compassionate, biblically-based counselor who provides advice based on the truths of Scripture. Include Bible verses where appropriate.`;

  const response = await openai.chat.completions.create({
    model: "gpt-3.5-turbo",
    messages: [
      { role: "system", content: systemMessage },
      { role: "user", content: prompt },
    ],
    max_tokens: 200,
  });

  return (
    response.choices[0]?.message?.content ||
    "I'm sorry, I couldn't generate a response."
  );
}

// Telegram message handler
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;

  // Check if the message is a command
  const text = msg.text || "";

  if (text.toLowerCase() === "/start") {
    bot.sendMessage(
      chatId,
      "Welcome! I am a Bible-based counseling bot. Ask me a question or share your concern."
    );
    return;
  }

  // Generate a response from ChatGPT
  try {
    const response = await getBiblicalCounsel(text);
    bot.sendMessage(chatId, response);
  } catch (error) {
    console.error(error);
    bot.sendMessage(
      chatId,
      "Sorry, I encountered an error. Please try again later."
    );
  }
});
