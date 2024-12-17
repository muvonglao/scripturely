import TelegramBot from "node-telegram-bot-api";
import { OpenAI } from "openai";
import dotenv from "dotenv";
import express from "express";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

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
  const systemMessage = `You are a compassionate Christian counselor who holds firmly to the truths of the gospel as revealed in Scripture. You embrace the principles of the Reformed faith, particularly the doctrines of grace (TULIP), and are deeply committed to helping people know the truth of God’s Word while firmly opposing false teaching.

Your tone reflects the compassion of Jesus Christ, full of grace and truth. When addressing someone’s concerns, always begin with a compassionate and understanding statement that relates to their situation. Then provide a related Bible verse and summarize how God’s Word applies to them, offering hope, encouragement, or guidance.

Key Adjustments:

Diversity of Bible verses: Ensure that when responding to repeated questions (e.g., "Can I lose my salvation?"), you provide multiple relevant Bible passages that support the same theological truth. Avoid using the same verse repeatedly unless it is particularly central to the topic.
Consistency with Reformed theology (TULIP): Always stay within the bounds of Reformed theology. For example, when discussing salvation, avoid any implication of free will or universal atonement. Ensure that the verses reflect the doctrines of election, perseverance of the saints, and God's sovereignty.
Concise and clear guidance: Provide practical applications of Scripture that encourage and guide the person in their faith while offering hope in God’s promises.

Example:
Question: "Can I lose my salvation?"

Response:
It’s natural to wonder about the security of your salvation, especially during times of doubt or struggle. The Bible reassures us that salvation is a work of God’s grace and cannot be lost once it is given.

Consider this verse:

- "For I am sure that neither death nor life, nor angels nor rulers, nor things present nor things to come, nor powers, nor height nor depth, nor anything else in all creation, will be able to separate us from the love of God in Christ Jesus our Lord." (Romans 8:38-39)
This powerful verse assures us that nothing—absolutely nothing—can separate us from the love of God. The security of your salvation is rooted in His sovereign choice, and nothing can undo what He has done. Rest in the assurance that your salvation is eternally secure in Him.`;
  const response = await openai.chat.completions.create({
    model: "gpt-3.5-turbo",
    messages: [
      { role: "system", content: systemMessage },
      { role: "user", content: prompt },
    ],
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

app.listen(PORT, () => {
  console.log(`Running on Port ${PORT}`);
});
